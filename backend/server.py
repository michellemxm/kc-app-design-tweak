"""Select-to-Edit backend for KiroClaw.

A small stdlib-only HTTP server that receives `visual_edit_request` payloads
from the dashboard app page and persists them to a queue directory that the
`visual-edit` skill instructs the agent to read.

Bound to localhost; KiroClaw proxies `/apps/poke-and-prose/api/*` to
this process (stripping the prefix, so the server sees `/api/<path>` or `/<path>`).

Endpoints (as seen after proxy prefix strip):
  GET  /health              → {"status","app","version","pending"}
  POST /submit              → body = visual_edit_request; persists → {"ok","id","savedTo"}
  GET  /queue               → {"pending":[{id,createdAt,comment,mode,count,previewUrl}]}
  GET  /latest              → newest pending request (full payload) or {}
  POST /clear?id=<id>       → move request to handled/ → {"ok","id"}
  POST /thread?id=<id>      → append {role,text,status?} to a request thread

Delivery model: this process cannot call the agent directly (separate process).
Instead it writes the structured payload to the app data queue dir; the bundled
`visual-edit` skill teaches the agent to read + act on it. This is the spec's
sanctioned "well-known file the agent watches" fallback.
"""

from __future__ import annotations

import html as _html
import json
import os
import re
import time
import uuid
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import urllib.request
import urllib.error

def _manifest_version() -> str:
    """Read the version from app.json rather than duplicating it here.

    A hardcoded constant drifts silently — this one sat at 0.6.0 while the
    manifest said 0.7.1, so /health reported a version that had not been real for
    two releases, which is worse than reporting nothing.
    """
    try:
        p = Path(__file__).resolve().parent.parent / "app.json"
        return str(json.loads(p.read_text("utf-8")).get("version", "")) or "0.0.0"
    except (OSError, ValueError):
        return "0.0.0"


VERSION = _manifest_version()
PORT = int(os.environ.get("PORT", 9110))
APP_NAME = (
    os.environ.get("KIROCREW_APP_NAME")
    or os.environ.get("KIROCLAW_APP_NAME")  # legacy host fallback
    or "poke-and-prose"
)

# Public (browser-facing) proxy paths — resolved through the gateway proxy.
PROXY_PUBLIC_BASE = f"/apps/{APP_NAME}/api/proxy/"
INJECT_PUBLIC = f"/apps/{APP_NAME}/api/proxy-inject.js"
# The drop-in overlay lives at <app>/inject/select-to-edit.js
INJECT_FILE = (Path(__file__).resolve().parent.parent / "inject" / "select-to-edit.js")

# Source of the previewed app. Exactly one of these is active at a time:
#   _ROOT   — an absolute folder path served directly by this backend (preferred).
#   _TARGET — a localhost dev-server URL reverse-proxied (for Vite/HMR projects).
# Both are localhost/local-filesystem only (no SSRF, no arbitrary FS escape).
_ROOT = ""
_TARGET = ""

# Resolve the app data dir. The host does not inject a data-dir env, so we
# fall back to the platform-standard location under ~/.kirocrew/apps/<name>/data
# (KIROCREW_HOME points at ~/.kirocrew). Legacy env names / ~/.kiroclaw are kept
# as a last resort so the app still works on the older host.
_DATA_ENV = (
    os.environ.get("KIROCREW_APP_DATA_DIR")
    or os.environ.get("KIROCREW_APP_DATA")
    or os.environ.get("KIROCLAW_APP_DATA_DIR")
    or os.environ.get("KIROCLAW_APP_DATA")
    or ""
)
if _DATA_ENV:
    DATA_DIR = Path(_DATA_ENV).expanduser().resolve()
else:
    _home = os.environ.get("KIROCREW_HOME")
    _base = Path(_home).expanduser() if _home else (Path(os.path.expanduser("~")) / ".kirocrew")
    if not _home and not _base.exists() and (Path(os.path.expanduser("~")) / ".kiroclaw").exists():
        _base = Path(os.path.expanduser("~")) / ".kiroclaw"  # legacy host
    DATA_DIR = (_base / "apps" / APP_NAME / "data").resolve()

QUEUE_DIR = DATA_DIR / "queue"
HANDLED_DIR = DATA_DIR / "handled"
QUEUE_DIR.mkdir(parents=True, exist_ok=True)
HANDLED_DIR.mkdir(parents=True, exist_ok=True)

MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MB cap on a single payload
_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")  # queue file id safety

import threading
_PICK_LOCK = threading.Lock()  # one native folder picker at a time

# ---------------------------------------------------------------------------
# Persistent config: registered projects, active project, request counter.
# ---------------------------------------------------------------------------
CONFIG_FILE = DATA_DIR / "config.json"
APP_DIR = Path(__file__).resolve().parent.parent

# The app's own git repo (for self-update + "open on GitHub").
try:
    REPO_URL = json.loads((APP_DIR / "app.json").read_text()).get("repository", "")
except (OSError, ValueError):
    REPO_URL = ""


def _load_cfg() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
        if isinstance(cfg, dict):
            cfg.setdefault("projects", [])
            cfg.setdefault("activeId", "")
            cfg.setdefault("counter", 0)
            return cfg
    except (OSError, ValueError):
        pass
    return {"projects": [], "activeId": "", "counter": 0}


def _save_cfg(cfg: dict) -> None:
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    tmp.replace(CONFIG_FILE)


_CFG = _load_cfg()


def _active_project() -> dict | None:
    for p in _CFG["projects"]:
        if p["id"] == _CFG["activeId"]:
            return p
    return None


def _next_number(project_id: str = "") -> int:
    """The next request number **within one project**.

    Numbering is per-app so each web app reads as its own sequence: app B's first
    request is "Request 1", not "Request 7" because six unrelated requests were
    filed against app A. Derived by scanning, not stored — a stored per-project
    counter would be a second source of truth to keep in sync, and the request
    files already know their own numbers.

    Falls back to the legacy global counter when there is no project id, so
    pre-0.9 requests and any unscoped caller keep working.
    """
    if not project_id:
        _CFG["counter"] = int(_CFG.get("counter", 0)) + 1
        _save_cfg(_CFG)
        return _CFG["counter"]
    highest = 0
    for d in (QUEUE_DIR, HANDLED_DIR):
        for fp in d.glob("*.json"):
            req = _read_request(fp)
            if not req or req.get("projectId") != project_id:
                continue
            try:
                highest = max(highest, int(req.get("number") or 0))
            except (TypeError, ValueError):
                continue
    return highest + 1


def _new_id() -> str:
    return f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _pending_files() -> list[Path]:
    return sorted(QUEUE_DIR.glob("*.json"))


def _el_name(el: dict) -> str:
    """Human-readable element label, e.g. 'nav#site-header' or 'div.card.grid'."""
    name = el.get("tag", "")
    if el.get("id"):
        name += f"#{el['id']}"
    elif el.get("classes"):
        name += "." + ".".join(el["classes"][:2])
    return name


# ---------------------------------------------------------------------------
# Request / comment model.
#
# A queue file is ONE REQUEST that contains MANY COMMENTS as sub-items:
#
#   { type, id, number, state: "draft"|"sent", projectId, projectRoot,
#     createdAt, sentAt, thread: [...],                     # request-level notes
#     comments: [ { cid, index, status, comment, createdAt,
#                   selection, previewUrl, sourceFile,
#                   followUpTo, thread: [...] } ] }
#
# Lifecycle (seal-on-send): comments land in the project's single OPEN DRAFT.
# Sending seals that draft (state -> "sent") and it never accepts comments
# again, so the next comment always opens a fresh draft — even while the
# previous batch is still being worked.
# ---------------------------------------------------------------------------
_COMMENT_STATUSES = ("new", "sent", "done")


def _request_status(req: dict) -> str:
    """Roll a request's comment statuses up into one request-level status.

    Comment statuses are AUTHORITATIVE; `state` is only a hint about whether the
    batch was formally sealed. This asymmetry matters: an agent that writes an
    unexpected `state` (or an old file with none) must never make a request that
    is plainly in flight read as an unsent draft. So "draft" is returned only
    when nothing has happened yet — explicit draft state AND every comment new.
    """
    comments = req.get("comments") or []
    if not comments:
        return "draft"
    if all(c.get("status") == "done" for c in comments):
        return "done"
    if req.get("state") != "draft" or any(c.get("status") != "new" for c in comments):
        return "sent"
    return "draft"


def _is_draft(req: dict) -> bool:
    """True only for a request that is still open for new comments."""
    return _request_status(req) == "draft"



def _summarize_comment(c: dict) -> dict:
    sel = c.get("selection") or {}
    elements = sel.get("elements") or []
    el = elements[0] if elements else {}
    return {
        "cid": c.get("cid", ""),
        "index": c.get("index", 0),
        "status": c.get("status", "new"),
        "comment": c.get("comment", ""),
        "createdAt": c.get("createdAt", ""),
        "element": _el_name(el),
        "locator": el.get("locator", ""),
        # Fallback anchors, so a pin survives its element being deleted (parent) or
        # not existing yet (point). The overlay tries them in that order.
        "parentLocator": el.get("parentLocator", ""),
        "point": el.get("point") or {},
        "count": len(elements),
        "mode": sel.get("mode", "single"),
        "previewUrl": c.get("previewUrl", ""),
        "projectId": c.get("projectId", ""),
        "sourceFile": c.get("sourceFile", ""),
        # Where the agent should edit, and how much to trust it:
        # data-kiro-source → "high", React Fiber → "medium", neither → "low".
        # Independent of how the page was served, so a dev-server project gets
        # BETTER targeting than a proxied static folder, not worse.
        "source": el.get("source") or {},
        "followUpTo": c.get("followUpTo", ""),
        "thread": c.get("thread") or [],
    }


def _summarize(req: dict) -> dict:
    """Panel-facing shape of a request: metadata + its comments as sub-items."""
    comments = req.get("comments") or []
    return {
        "id": req.get("id", ""),
        "number": req.get("number", 0),
        "state": req.get("state", "draft"),
        "status": _request_status(req),
        "createdAt": req.get("createdAt", ""),
        "sentAt": req.get("sentAt", ""),
        "projectId": req.get("projectId", ""),
        "projectRoot": req.get("projectRoot", ""),
        "thread": req.get("thread") or [],
        "doneCount": sum(1 for c in comments if c.get("status") == "done"),
        "comments": [_summarize_comment(c) for c in comments],
    }


def _proj_for_preview(preview_url: str) -> tuple[dict | None, str]:
    """Resolve (project, path-within-project) from a preview URL.

    Proxied preview URLs look like `/apps/<app>/api/proxy/<projectId>/<rel>`, so
    the project id and the served file both fall out of the path. Returns
    `(None, "")` for any URL that isn't ours — notably a dev-server URL like
    `http://localhost:5173/pricing`, where the path is a ROUTE, not a file. Use
    `_resolve_project` instead of calling this directly: identity should come
    from an explicit id, with this as the fallback for older payloads.
    """
    marker = "/api/proxy/"
    i = str(preview_url).find(marker)
    if i == -1:
        return None, ""
    rel = str(preview_url)[i + len(marker):].split("?")[0].split("#")[0]
    seg = rel.split("/", 1)[0] if rel else ""
    rest = rel.split("/", 1)[1] if "/" in rel else ""
    proj = next((p for p in _CFG["projects"] if p["id"] == seg), None)
    return proj, rest


def _project_by_id(project_id: str) -> dict | None:
    if not project_id:
        return None
    return next((p for p in _CFG["projects"] if p["id"] == project_id), None)


def _resolve_project(payload: dict) -> tuple[str, str, str]:
    """Identify the project a captured comment belongs to.

    Returns `(projectId, projectRoot, sourceFile)`.

    Identity comes from an EXPLICIT `projectId` on the payload — the panel knows
    which project it is previewing, so it says so. The URL is only parsed as a
    fallback for payloads written before that field existed. This matters beyond
    tidiness: pattern-matching `/api/proxy/<id>/` only works for content this
    backend proxies, so a project previewed straight from its dev server would
    otherwise resolve to no project at all — losing its pins, its per-comment
    threads, and its grouping.

    `sourceFile` is only meaningful when the URL names a served FILE. A
    dev-server route (`/pricing`) is not a path on disk, so it is left empty and
    the agent relies on the per-element `source` block (`data-kiro-source` →
    high confidence, React Fiber → medium) instead.
    """
    preview_url = str(payload.get("previewUrl", ""))
    explicit = str(payload.get("projectId", "") or "")

    proj = _project_by_id(explicit)
    served_rel = ""
    if proj is not None:
        # Trust the id; still read the served path off the URL when it IS ours,
        # so proxied projects keep exact per-page source files.
        url_proj, served_rel = _proj_for_preview(preview_url)
        if url_proj is not None and url_proj["id"] != proj["id"]:
            served_rel = ""       # URL disagrees with the id — don't guess a file
    else:
        proj, served_rel = _proj_for_preview(preview_url)

    if proj is not None:
        root = proj["path"]
        return proj["id"], root, (str(Path(root) / served_rel) if served_rel else "")
    if _ROOT:
        return explicit, _ROOT, (str(Path(_ROOT) / served_rel) if served_rel else "")
    return explicit, "", ""



def _read_request(fp: Path) -> dict | None:
    try:
        req = json.loads(fp.read_text("utf-8"))
        return req if isinstance(req, dict) else None
    except (OSError, ValueError):
        return None


def _write_request(fp: Path, req: dict) -> None:
    fp.write_text(json.dumps(req, indent=2), encoding="utf-8")


def _find_request(rid: str) -> Path | None:
    """Locate a request file by id, queue/ first then handled/."""
    for d in (QUEUE_DIR, HANDLED_DIR):
        fp = d / f"{rid}.json"
        if fp.is_file():
            return fp
    return None


def _open_draft_file(project_id: str) -> Path | None:
    """The project's single open draft, if one exists.

    Uses the derived status, not raw `state`, so a request whose comments are
    already being worked can never quietly collect new comments.
    """
    for fp in _pending_files():
        req = _read_request(fp)
        if req and req.get("projectId") == project_id and _is_draft(req):
            return fp
    return None



def _valid_target(url: str) -> bool:
    """Only allow http://localhost[:port] or http://127.0.0.1[:port] (SSRF guard)."""
    try:
        u = urlparse(url)
    except ValueError:
        return False
    if u.scheme != "http":
        return False
    return (u.hostname or "").lower() in {"localhost", "127.0.0.1"}


def _valid_root(path: str):
    """Resolve a folder path to serve. Returns a resolved Path or None if it is
    not an existing directory or is a sensitive credential location."""

    try:
        p = Path(os.path.expanduser(path)).resolve()
    except (ValueError, OSError):
        return None
    if not p.is_dir():
        return None
    if set(p.parts) & {".ssh", ".aws", ".gnupg", ".kube", ".docker"}:
        return None
    return p


# Boot-time restore: resume serving the active project across restarts.
_boot_active = _active_project()
if _boot_active:
    _boot_root = _valid_root(_boot_active.get("path", ""))
    if _boot_root is not None:
        _ROOT = str(_boot_root)


_CTYPE_OVERRIDES = {    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".html": "text/html",
    ".htm": "text/html",
}


def _guess_ctype(p: Path) -> str:
    ext = p.suffix.lower()
    if ext in _CTYPE_OVERRIDES:
        return _CTYPE_OVERRIDES[ext]
    mime, _ = mimetypes.guess_type(str(p))
    return mime or "application/octet-stream"


# ---------------------------------------------------------------------------
# Dev-server detection.
#
# A project registered as a folder may also be served by a dev server the user
# already has running. Rather than guessing from a list of popular ports — which
# picks the wrong server the moment two are up — identify it: every loopback
# listener has a PID, every PID has a working directory, and the one whose
# working directory sits inside the project folder IS that project's dev server.
#
# `lsof` is the only portable way to get that mapping without elevated
# privileges, and the two invocations below work identically on macOS and Linux.
# Detection is always best-effort: if lsof is missing or slow, callers fall back
# to the manual URL field.
# ---------------------------------------------------------------------------
_LSOF_TIMEOUT = 4          # generous: lsof on a busy machine can take ~1s
_PROBE_TIMEOUT = 1.5       # per-candidate HTTP probe


def _lsof_fields(args: list[str]) -> list[dict]:
    """Run lsof in field mode and return one dict per record.

    Field output is a flat stream of `p<pid>` / `f<fd>` / `n<name>` lines where
    the pid line begins a new process block, so `p` is carried forward.
    """
    import subprocess
    try:
        r = subprocess.run(["lsof", *args], capture_output=True, text=True,
                           timeout=_LSOF_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return []
    out: list[dict] = []
    pid = ""
    for line in r.stdout.splitlines():
        if not line:
            continue
        tag, val = line[0], line[1:]
        if tag == "p":
            pid = val
        elif tag == "n":
            out.append({"pid": pid, "name": val})
    return out


def _loopback_listeners() -> dict[int, int]:
    """{port: pid} for TCP listeners bound to loopback (or all interfaces)."""
    found: dict[int, int] = {}
    for rec in _lsof_fields(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]):
        name = rec["name"]
        if ":" not in name:
            continue
        host, _, port_s = name.rpartition(":")
        host = host.strip("[]")
        # `*` means all interfaces, which includes loopback.
        if host not in ("127.0.0.1", "localhost", "::1", "*", ""):
            continue
        try:
            port = int(port_s)
            found[port] = int(rec["pid"])
        except ValueError:
            continue
    return found


def _cwd_for_pids(pids: list[int]) -> dict[int, str]:
    """{pid: working directory} — one lsof call for the whole set."""
    if not pids:
        return {}
    joined = ",".join(str(p) for p in dict.fromkeys(pids))
    out: dict[int, str] = {}
    for rec in _lsof_fields(["-a", "-p", joined, "-d", "cwd", "-Fn"]):
        try:
            out[int(rec["pid"])] = rec["name"]
        except ValueError:
            continue
    return out


def _serves_html(port: int) -> bool:
    """Does this port answer with an HTML page?

    Discriminates a dev server from the API server / test runner / language
    server that may also be running out of the same folder. Deliberately lenient
    about status: a dev server can answer `/` with a 404 and still be the right
    target, so only the content type has to look like a page.
    """
    url = f"http://127.0.0.1:{port}/"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "DesignTweak-Detect"})
        with urllib.request.urlopen(req, timeout=_PROBE_TIMEOUT) as resp:  # noqa: S310
            return "text/html" in (resp.headers.get("Content-Type") or "").lower()
    except urllib.error.HTTPError as exc:
        return "text/html" in (exc.headers.get("Content-Type") or "").lower()
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _detect_dev_servers(root: Path, probe: bool = True) -> list[dict]:
    """Dev servers plausibly serving `root`, best match first.

    A candidate matches when the listening process's working directory is inside
    the project folder — which also covers a monorepo whose server runs from
    `<root>/apps/web`. Depth 0 (cwd IS the root) sorts first, since a server
    started in the project root is the more likely target than one nested in it.
    """
    listeners = _loopback_listeners()
    cwds = _cwd_for_pids(list(listeners.values()))

    out: list[dict] = []
    for port, pid in listeners.items():
        cwd = cwds.get(pid, "")
        if not cwd:
            continue
        try:
            depth = len(Path(cwd).resolve().relative_to(root).parts)
        except ValueError:
            continue                      # cwd is not inside the project
        out.append({
            "port": port, "pid": pid, "cwd": cwd, "depth": depth,
            "url": f"http://localhost:{port}",
            "servesHtml": _serves_html(port) if probe else None,
        })
    # HTML-serving first, then shallowest cwd, then lowest port for stability.
    out.sort(key=lambda c: (c["servesHtml"] is False, c["depth"], c["port"]))
    return out


def _auto_dev_server(root: Path) -> str:
    """The one unambiguous dev-server URL for `root`, or "".

    Returns a URL only when exactly ONE candidate serves HTML. With none there is
    nothing to attach; with several, guessing would silently point the preview at
    the wrong server, so the caller surfaces the list instead.
    """
    html = [c for c in _detect_dev_servers(root) if c["servesHtml"]]
    return html[0]["url"] if len(html) == 1 else ""


# ---------------------------------------------------------------------------
# Dev-server processes we started.
#
# Spawned in their own session (`start_new_session`) so the whole process tree can
# be signalled as a group: `npm run dev` forks the real server as a child, so
# killing only the npm pid leaves an orphan holding the port. Registered with
# atexit so a gateway shutdown does not leak them either.
# ---------------------------------------------------------------------------
_DEV_PROCS: dict[str, dict] = {}      # projectId -> {proc, pgid, url, log}
_START_TIMEOUT = 45                   # cold Vite/Next can take a while
_STOP_GRACE = 3


def _stop_dev_proc(project_id: str) -> bool:
    """Signal the whole process group, escalating only if it ignores SIGTERM."""
    import signal
    rec = _DEV_PROCS.pop(project_id, None)
    if not rec:
        return False
    _stop_inject_proxy(rec)
    proc, pgid = rec.get("proc"), rec.get("pgid")
    if proc is None:                  # adopted server: proxy was ours, process is not
        return True
    try:
        if pgid:
            os.killpg(pgid, signal.SIGTERM)
        else:
            proc.terminate()
        try:
            proc.wait(timeout=_STOP_GRACE)
        except Exception:                                  # noqa: BLE001
            if pgid:
                os.killpg(pgid, signal.SIGKILL)
            else:
                proc.kill()
    except (ProcessLookupError, PermissionError, OSError):
        pass                                               # already gone
    return True


def _stop_all_dev_procs() -> None:
    for pid in list(_DEV_PROCS):
        _stop_dev_proc(pid)


import atexit  # noqa: E402
atexit.register(_stop_all_dev_procs)


def _dev_proc_alive(project_id: str) -> bool:
    rec = _DEV_PROCS.get(project_id)
    if not rec:
        return False
    proc = rec.get("proc")
    if proc is None:                    # adopted: the user's server, our proxy
        return bool(rec.get("proxy"))
    return proc.poll() is None


# ---------------------------------------------------------------------------
# Injecting reverse proxy for dev servers
#
# The overlay is what makes select-to-edit work, and it is injected by THIS
# backend when it serves a folder from disk. Point the iframe straight at a dev
# server and the overlay never loads — Vite serves its own index.html, and no
# amount of postMessage plumbing helps because there is nothing in the page to
# talk to. Framing the dev server directly preserved hot reload and silently
# dropped the app's entire reason for existing.
#
# So a dev server is framed THROUGH a proxy that injects the overlay. Two
# decisions make this robust rather than a URL-rewriting game:
#
#   • It listens on its OWN port and maps paths 1:1. A dev server's HTML refers
#     to root-absolute URLs (/src/main.tsx, /@vite/client) and its client builds
#     more at runtime; behind a /proxy/<id>/ path prefix every one of them would
#     miss. Identity mapping means nothing needs rewriting but the script tag.
#   • WebSocket upgrades are relayed as raw bytes, so hot reload keeps working.
#     Once the handshake is done a WS connection is just a byte stream — we never
#     parse a frame, and the accept key is computed by the dev server, not us.
# ---------------------------------------------------------------------------
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
# Served by the proxy itself, so the overlay needs no cross-origin fetch and no
# knowledge of which port this backend is on.
_OVERLAY_PATH = "/__kiro_select_to_edit__.js"
_WS_IDLE = 3600            # a quiet HMR socket is normal; don't tear it down
_RELAY_TIMEOUT = 30


class _DevProxyHandler(BaseHTTPRequestHandler):
    """Byte-transparent reverse proxy, except HTML gains the overlay script."""

    protocol_version = "HTTP/1.1"
    upstream_host = "127.0.0.1"
    upstream_port = 0

    def log_message(self, *args) -> None:
        pass

    def _upstream(self) -> str:
        return f"{self.upstream_host}:{self.upstream_port}"

    def _dispatch(self) -> None:
        if self.path.split("?", 1)[0] == _OVERLAY_PATH:
            return self._serve_overlay()
        if "websocket" in self.headers.get("Upgrade", "").lower():
            return self._relay_ws()
        return self._relay_http()

    do_GET = _dispatch
    do_POST = _dispatch
    do_HEAD = _dispatch
    do_PUT = _dispatch
    do_PATCH = _dispatch
    do_DELETE = _dispatch
    do_OPTIONS = _dispatch

    def _serve_overlay(self) -> None:
        try:
            js = INJECT_FILE.read_bytes()
        except OSError:
            js = b"// overlay not found"
        self.send_response(200)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(js)))
        self.end_headers()
        self.wfile.write(js)

    def _relay_http(self) -> None:
        import http.client

        body = b""
        length = self.headers.get("Content-Length")
        if length:
            try:
                body = self.rfile.read(int(length))
            except (ValueError, OSError):
                body = b""

        headers = {}
        for key, value in self.headers.items():
            low = key.lower()
            # Accept-Encoding is dropped so the upstream answers in identity
            # encoding — otherwise the HTML would arrive gzipped and the overlay
            # tag could not be inserted without decompressing it first.
            if low in _HOP_BY_HOP or low in ("accept-encoding", "host"):
                continue
            headers[key] = value
        headers["Host"] = self._upstream()

        try:
            conn = http.client.HTTPConnection(
                self.upstream_host, self.upstream_port, timeout=_RELAY_TIMEOUT)
            conn.request(self.command, self.path, body=body or None, headers=headers)
            resp = conn.getresponse()
            payload = resp.read()
        except (OSError, http.client.HTTPException) as exc:
            self.send_error(502, f"dev server unreachable: {exc}")
            return

        if "text/html" in (resp.getheader("Content-Type") or "").lower():
            payload = _rewrite_html(payload, base=None, script=_OVERLAY_PATH)

        self.send_response(resp.status)
        for key, value in resp.getheaders():
            if key.lower() in _HOP_BY_HOP or key.lower() == "content-length":
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
        conn.close()

    def _relay_ws(self) -> None:
        import selectors
        import socket

        try:
            up = socket.create_connection(
                (self.upstream_host, self.upstream_port), timeout=10)
        except OSError:
            self.send_error(502, "dev server unreachable")
            return

        # Replay the handshake verbatim; the upstream's 101 comes back through the
        # byte pump below, so we never compute Sec-WebSocket-Accept ourselves.
        lines = [f"{self.command} {self.path} HTTP/1.1"]
        for key, value in self.headers.items():
            lines.append(f"{key}: {self._upstream() if key.lower() == 'host' else value}")
        try:
            up.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1", "replace"))
        except OSError:
            up.close()
            return

        self.close_connection = True
        down = self.connection
        up.settimeout(None)
        down.settimeout(None)
        sel = selectors.DefaultSelector()
        sel.register(up, selectors.EVENT_READ, down)
        sel.register(down, selectors.EVENT_READ, up)
        try:
            while True:
                events = sel.select(timeout=_WS_IDLE)
                if not events:
                    return                                  # idle past the cap
                for key, _mask in events:
                    try:
                        chunk = key.fileobj.recv(65536)
                    except OSError:
                        return
                    if not chunk:
                        return                              # either side hung up
                    try:
                        key.data.sendall(chunk)
                    except OSError:
                        return
        finally:
            sel.close()
            try:
                up.close()
            except OSError:
                pass


def _start_inject_proxy(dev_url: str) -> tuple[object | None, str]:
    """Front `dev_url` with an overlay-injecting proxy. Returns (server, url)."""
    parsed = urlparse(dev_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    bound = type("_BoundDevProxy", (_DevProxyHandler,),
                 {"upstream_host": host, "upstream_port": port})
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", 0), bound)
    except OSError:
        return None, ""
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True,
                     name="kiro-dev-proxy").start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/"


def _stop_inject_proxy(rec: dict) -> None:
    srv = rec.get("proxy")
    if srv is None:
        return
    try:
        srv.shutdown()
        srv.server_close()
    except Exception:                                       # noqa: BLE001
        pass
    rec["proxy"] = None


def _front_with_proxy(project_id: str, dev_url: str) -> str:
    """Attach an injecting proxy to a running dev server; return the URL to frame.

    Falls back to the bare dev URL if the proxy cannot be started — a preview
    without select-to-edit is still better than no preview, and the caller
    surfaces the difference.
    """
    rec = _DEV_PROCS.get(project_id)
    srv, url = _start_inject_proxy(dev_url)
    if not url:
        return dev_url
    if rec is not None:
        _stop_inject_proxy(rec)
        rec["proxy"] = srv
        rec["proxyUrl"] = url
    else:
        _DEV_PROCS[project_id] = {"proc": None, "pgid": None, "url": dev_url,
                                  "proxy": srv, "proxyUrl": url, "adopted": True}
    return url


def _start_dev_proc(project_id: str, root: Path) -> dict:
    """Start the project's dev server and wait until it is listening.

    Returns `{"ok": True, "url": …}` or `{"ok": False, "error": …, "log": …}`.

    The port is NOT chosen here — the dev tool picks its own, and we then find it
    by matching a listening port back to a process rooted in this folder. That
    avoids a per-framework table of port flags, and it is also what makes the
    result honest: we report the port something is actually listening on.
    """
    import subprocess
    if _dev_proc_alive(project_id):
        rec = _DEV_PROCS[project_id]
        return {"ok": True, "url": rec.get("proxyUrl") or rec["url"],
                "devUrl": rec["url"], "already": True}
    _stop_dev_proc(project_id)                    # clear a dead record

    cmd = _dev_command(root)
    if not cmd:
        return {"ok": False, "error":
                "No dev script found in package.json (looked for: "
                + ", ".join(_DEV_SCRIPTS) + ")."}

    # Resolve the package manager absolutely — the gateway hands this backend a
    # minimal PATH, so spawning by bare name fails with ENOENT even though the
    # same command works in a terminal.
    binary = _resolve_bin(cmd[0])
    if binary is None:
        looked = ", ".join(str(d) for d in _node_bin_dirs()[:4])
        return {"ok": False, "error":
                f"Could not find `{cmd[0]}`. Design Tweak's backend does not inherit "
                f"your shell's PATH, and {cmd[0]} is not in the usual places "
                f"({looked}…). Start the dev server yourself, then press "
                f"Dev server to connect to it."}

    if not (root / "node_modules").is_dir():
        return {"ok": False, "error":
                f"node_modules is missing — run `{cmd[0]} install` in {root.name} first."}

    log = DATA_DIR / f"devserver-{project_id}.log"
    try:
        handle = log.open("wb")
        proc = subprocess.Popen(                  # noqa: S603 (user's own project)
            [str(binary), *cmd[1:]], cwd=str(root),
            stdout=handle, stderr=subprocess.STDOUT,
            env=_child_env(binary.parent),        # node must be on PATH for npm's own child
            start_new_session=True,               # own process group → killable as a tree
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": f"could not start `{' '.join(cmd)}`: {exc}"}

    try:
        pgid = os.getpgid(proc.pid)
    except OSError:
        pgid = None
    _DEV_PROCS[project_id] = {"proc": proc, "pgid": pgid, "url": "",
                              "log": str(log), "proxy": None, "proxyUrl": ""}

    # Poll for the port it chose. Probing is skipped while polling: an HTTP request
    # per candidate per tick is wasteful, and a dev server that is listening but
    # still compiling would fail the HTML check and look like a miss.
    deadline = time.time() + _START_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:               # exited — surface its own output
            tail = ""
            try:
                tail = log.read_text("utf-8", errors="replace")[-800:]
            except OSError:
                pass
            _DEV_PROCS.pop(project_id, None)
            return {"ok": False, "error": f"`{' '.join(cmd)}` exited ({proc.returncode}).",
                    "log": tail}
        for cand in _detect_dev_servers(root, probe=False):
            if cand["pid"] == proc.pid or (pgid and _same_group(cand["pid"], pgid)):
                _DEV_PROCS[project_id]["url"] = cand["url"]
                # Frame the PROXY, not the dev server: the proxy is what injects
                # the select-to-edit overlay.
                framed = _front_with_proxy(project_id, cand["url"])
                return {"ok": True, "url": framed, "devUrl": cand["url"],
                        "port": cand["port"], "injected": framed != cand["url"]}
        time.sleep(0.4)

    _stop_dev_proc(project_id)
    return {"ok": False, "error":
            f"`{' '.join(cmd)}` did not start listening within {_START_TIMEOUT}s."}


def _same_group(pid: int, pgid: int) -> bool:
    """Is `pid` in process group `pgid`? The listener is usually a CHILD of npm."""
    try:
        return os.getpgid(pid) == pgid
    except OSError:
        return False



#
# Not every project folder has index.html at its top level: a repo may keep the
# static site in public/ or dist/, or nest the app in a subfolder (mono-repos).
# Rather than 404 on the folder request, look for the most likely entry file,
# and if there is none, render a page that lists the HTML files we DID find so
# the user can pick one instead of staring at a dead iframe.
# ---------------------------------------------------------------------------
_ENTRY_CANDIDATES = (
    "index.html", "index.htm",
    "public/index.html", "dist/index.html", "build/index.html", "out/index.html",
    "app/index.html", "src/index.html", "site/index.html", "www/index.html",
    "docs/index.html", "demo/index.html", "example/index.html", "examples/index.html",
)

# Directories that never contain the previewable entry point but do contain
# thousands of files — skipping them keeps the HTML scan fast.
_SCAN_SKIP_DIRS = {
    "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", ".cache", ".turbo",
    "__pycache__", ".venv", "venv", "coverage", "htmlcov", ".pytest_cache",
    "target", "vendor", ".idea", ".vscode",
}

# A module script pointing at TypeScript/JSX is a BUNDLER TEMPLATE, not a page.
# Browsers cannot execute .ts/.tsx/.jsx, so serving such an index.html statically
# yields HTTP 200, valid HTML, and a completely blank render — the worst kind of
# failure, because every layer reports success. Detect it and say so instead.
#
# Attributes are checked independently of order: `<script type="module" src=…>`
# and `<script src=… type="module">` are both valid HTML and both appear in real
# templates, so a single ordered pattern silently misses half of them.
_SCRIPT_TAG_RE = re.compile(r"<script\b([^>]*)>", re.IGNORECASE)
_ATTR_TYPE_MODULE_RE = re.compile(r"""\btype\s*=\s*["']module["']""", re.IGNORECASE)
_ATTR_SRC_RE = re.compile(r"""\bsrc\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
_UNBUNDLED_EXTS = (".ts", ".tsx", ".jsx")


def _unbundled_entry(html: bytes) -> str:
    """The first TS/JSX module script in this page, or "" if it can stand alone."""
    try:
        text = html.decode("utf-8", "replace")
    except (UnicodeDecodeError, AttributeError):
        return ""
    for m in _SCRIPT_TAG_RE.finditer(text):
        attrs = m.group(1)
        if not _ATTR_TYPE_MODULE_RE.search(attrs):
            continue
        src_m = _ATTR_SRC_RE.search(attrs)
        if not src_m:
            continue                      # inline module — nothing to fetch
        src = src_m.group(1)
        bare = src.split("?")[0].split("#")[0].lower()
        if bare.endswith(_UNBUNDLED_EXTS):
            return src
    return ""



# Where Node toolchains actually live. The gateway spawns this backend with a
# minimal PATH — typically /usr/bin:/bin:/usr/sbin:/sbin — so `npm` is NOT
# resolvable by name even though it works fine in the user's terminal. Two things
# follow: the binary has to be found absolutely, AND the child's PATH has to
# include its directory, because `npm run dev` shells out to `node` itself.
_NODE_BIN_DIRS = (
    "/opt/homebrew/bin",                 # homebrew, Apple silicon
    "/usr/local/bin",                    # homebrew (Intel) / manual installs
    "/opt/local/bin",                    # MacPorts
    "/usr/bin",
    "~/.volta/bin",
    "~/.bun/bin",
    "~/.asdf/shims",
    "~/.local/share/fnm/aliases/default/bin",
    "~/Library/pnpm",
)
# nvm keeps a directory per version; prefer the newest.
_NVM_GLOB = "~/.nvm/versions/node/*/bin"


def _node_bin_dirs() -> list[Path]:
    dirs = [Path(d).expanduser() for d in _NODE_BIN_DIRS]
    try:
        import glob
        nvm = sorted(glob.glob(os.path.expanduser(_NVM_GLOB)), reverse=True)
        dirs = [Path(p) for p in nvm] + dirs
    except OSError:
        pass
    return [d for d in dirs if d.is_dir()]


def _resolve_bin(name: str) -> Path | None:
    """Absolute path to a package-manager binary, or None.

    `shutil.which` is tried first so a properly-configured PATH wins; the
    directory scan is the fallback for the gateway's stripped environment.
    """
    import shutil
    found = shutil.which(name)
    if found:
        return Path(found)
    for d in _node_bin_dirs():
        cand = d / name
        if cand.is_file() and os.access(cand, os.X_OK):
            return cand
    return None


def _child_env(bin_dir: Path) -> dict:
    """Environment for the dev server: our own, with the toolchain on PATH."""
    env = dict(os.environ)
    extra = [str(bin_dir)] + [str(d) for d in _node_bin_dirs()]
    seen, parts = set(), []
    for p in extra + env.get("PATH", "").split(os.pathsep):
        if p and p not in seen:
            seen.add(p)
            parts.append(p)
    env["PATH"] = os.pathsep.join(parts)
    env.pop("NODE_OPTIONS", None)        # ours would leak into their build
    return env


def _pkg_scripts(root: Path) -> dict:
    try:
        data = json.loads((root / "package.json").read_text("utf-8"))
        s = data.get("scripts")
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


# Lockfile → the package manager that project expects. Order matters: a repo can
# carry more than one, and the more specific manager wins over npm's default.
_LOCKFILES = (
    ("pnpm-lock.yaml", "pnpm"),
    ("bun.lockb", "bun"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
)
# Script names that mean "run the dev server", best first.
_DEV_SCRIPTS = ("dev", "start:dev", "dev:web", "serve", "start")


def _dev_command(root: Path) -> list[str]:
    """The command that starts this project's dev server, or [] if none is obvious.

    Deliberately does NOT pass a port: the flag differs per framework (`--port` for
    Vite, `-p` for Next, …) and guessing wrong just fails. Let the tool choose its
    own port and find it afterwards with `_detect_dev_servers`.
    """
    scripts = _pkg_scripts(root)
    script = next((s for s in _DEV_SCRIPTS if s in scripts), "")
    if not script:
        return []
    pm = next((m for f, m in _LOCKFILES if (root / f).is_file()), "npm")
    return [pm, "run", script] if pm != "bun" else ["bun", "run", script]


def _classify_project(root: Path) -> dict:
    """Can this folder be previewed from disk, or does it need a dev server?

    The distinction is not "does it have an index.html" — a Vite project has one,
    and serving it statically yields a blank page because its only script is
    TypeScript. So: resolve the entry, and if that entry is a bundler template,
    the folder needs its dev server.
    """
    entry = _find_entry(root)
    unbundled = ""
    if entry is not None:
        try:
            unbundled = _unbundled_entry(entry.read_bytes())
        except OSError:
            unbundled = ""
    cmd = _dev_command(root)
    needs = bool(unbundled) or (entry is None and bool(cmd))
    return {
        "needsDevServer": needs,
        "devCommand": " ".join(cmd),
        # Named so the panel can explain WHY rather than just asserting it.
        "unbundledEntry": unbundled,
        "hasEntry": entry is not None,
    }


def _find_entry(folder: Path):
    """Best-guess entry HTML inside `folder`. Returns a Path or None."""
    for rel in _ENTRY_CANDIDATES:
        p = folder / rel
        if p.is_file():
            return p
    return None


def _scan_html(root: Path, limit: int = 40, max_depth: int = 3) -> list[str]:
    """Shallow scan for .html/.htm files, returned as root-relative POSIX paths."""
    found: list[str] = []

    def walk(d: Path, depth: int) -> None:
        if len(found) >= limit or depth > max_depth:
            return
        try:
            entries = sorted(d.iterdir(), key=lambda e: (e.is_dir(), e.name.lower()))
        except OSError:
            return
        for e in entries:
            if len(found) >= limit:
                return
            name = e.name
            if e.is_dir():
                if name.startswith(".") or name in _SCAN_SKIP_DIRS:
                    continue
                walk(e, depth + 1)
            elif e.suffix.lower() in (".html", ".htm"):
                try:
                    found.append(e.relative_to(root).as_posix())
                except ValueError:
                    continue

    walk(root, 0)
    return found


def _rewrite_html(body: bytes, base: str | None = PROXY_PUBLIC_BASE,
                  script: str = INJECT_PUBLIC) -> bytes:
    """Inject the Select-to-Edit overlay, and optionally a <base> tag.

    `base=None` is for the dev-server proxy, which maps paths 1:1 and so needs no
    <base> — adding one there would repoint every relative URL and break the page.
    """
    try:
        html = body.decode("utf-8", "replace")
    except (UnicodeDecodeError, AttributeError):
        return body
    inject_tag = f'<script src="{script}"></script>'
    if base is not None:
        base_tag = f'<base href="{base}">'
        low = html.lower()
        head = low.find("<head")
        if head != -1:
            end = low.find(">", head)
            if end != -1:
                html = html[: end + 1] + base_tag + html[end + 1 :]
        else:
            html = base_tag + html
    bidx = html.lower().rfind("</body>")
    if bidx != -1:
        html = html[:bidx] + inject_tag + html[bidx:]
    else:
        html = html + inject_tag
    return html.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "KiroClaw-SelectToEdit/" + VERSION

    def log_message(self, *args) -> None:  # silence default logging
        pass

    # ---- routing ----
    def _route(self) -> tuple[str, dict]:
        url = urlparse(self.path)
        route = url.path.rstrip("/") or "/"
        if route.startswith("/api/"):
            route = route[4:] or "/"
        elif route == "/api":
            route = "/"
        return route, parse_qs(url.query)

    def do_GET(self) -> None:  # noqa: N802
        try:
            route, qs = self._route()
            if route in ("/", "/health"):
                return self._json(200, {
                    "status": "ok",
                    "app": APP_NAME,
                    "version": VERSION,
                    "pending": len(_pending_files()),
                    "dataDir": str(DATA_DIR),
                })
            if route == "/queue":
                # Requests, oldest first — each carries its comments as sub-items.
                pending = []
                for fp in _pending_files():
                    req = _read_request(fp)
                    if req is not None:
                        pending.append(_summarize(req))
                pending.sort(key=lambda r: r.get("number") or 0)
                return self._json(200, {"pending": pending})
            if route == "/latest":
                # The newest request, full payload — what the agent reads to work
                # a batch it was just handed.
                files = _pending_files()
                if not files:
                    return self._json(200, {})
                newest, newest_num = None, -1
                for fp in files:
                    req = _read_request(fp)
                    if req and (req.get("number") or 0) > newest_num:
                        newest, newest_num = req, req.get("number") or 0
                return self._json(200, newest or {})
            if route == "/projects":
                return self._h_projects_list()
            if route == "/detect-dev-server":
                return self._h_detect_dev_server(qs)
            if route == "/history":
                done = []
                for fp in sorted(HANDLED_DIR.glob("*.json"), reverse=True)[:50]:
                    req = _read_request(fp)
                    if req is not None:
                        done.append(_summarize(req))
                return self._json(200, {"history": done})
            if route == "/proxy-inject.js":
                return self._h_inject()
            if route == "/proxy" or route.startswith("/proxy/"):
                sub = route[len("/proxy"):] or "/"
                return self._h_proxy(sub)
            return self._json(404, {"error": f"GET {route} not found"})
        except Exception as exc:  # noqa: BLE001
            return self._json(500, {"error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        try:
            route, qs = self._route()
            if route == "/submit":
                return self._h_submit()
            if route == "/clear":
                return self._h_clear(qs)
            if route == "/delete":
                return self._h_delete(qs)
            if route in ("/source", "/target"):
                return self._h_set_source()
            if route == "/projects":
                return self._h_projects_add()
            if route == "/projects/select":
                return self._h_projects_select()
            if route == "/projects/remove":
                return self._h_projects_remove()
            if route == "/projects/preview-url":
                return self._h_projects_preview_url()
            if route == "/dev-server/start":
                return self._h_dev_server_start(qs)
            if route == "/dev-server/stop":
                return self._h_dev_server_stop(qs)
            if route == "/pick-folder":
                return self._h_pick_folder()
            if route == "/send":
                return self._h_send(qs)
            if route == "/delete-comment":
                return self._h_delete_comment(qs)
            if route == "/thread":
                return self._h_thread(qs)
            if route == "/self-update":
                return self._h_self_update()
            return self._json(404, {"error": f"POST {route} not found"})
        except Exception as exc:  # noqa: BLE001
            return self._json(500, {"error": str(exc)})

    # ---- handlers ----
    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("payload too large")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("payload must be a JSON object")
        return data

    def _h_submit(self) -> None:
        """Append a captured comment to the project's OPEN DRAFT request.

        Creates the draft if there isn't one. Never dispatches — sending is an
        explicit, separate step (POST /send) so a batch of comments goes to the
        agent as a single request.
        """
        payload = self._read_body()
        if payload.get("type") != "visual_edit_request":
            return self._json(400, {"error": "type must be 'visual_edit_request'"})
        sel = payload.get("selection") or {}
        if not isinstance(sel, dict) or not sel.get("elements"):
            return self._json(400, {"error": "selection.elements is required"})

        preview_url = str(payload.get("previewUrl", ""))
        project_id, project_root, source_file = _resolve_project(payload)

        # Find or open the draft for this project.
        fp = _open_draft_file(project_id)
        if fp is None:
            rid = _new_id()
            req = {
                "type": "visual_edit_batch",
                "id": rid,
                "number": _next_number(project_id),
                "state": "draft",
                "projectId": project_id,
                "projectRoot": project_root,
                "createdAt": _now_iso(),
                "sentAt": "",
                "thread": [],
                "comments": [],
            }
            fp = QUEUE_DIR / f"{rid}.json"
        else:
            req = _read_request(fp)
            if req is None:
                return self._json(500, {"error": "draft request unreadable"})

        comments = req.setdefault("comments", [])
        cid = payload.get("cid") or _new_id()
        if not _ID_RE.match(str(cid)):
            cid = _new_id()
        created = payload.get("createdAt") or _now_iso()

        # A follow-up references an earlier comment (possibly in an already-sent
        # request); it still ships in THIS batch, just linked to its origin.
        follow_up_to = str(payload.get("followUpTo", "") or "")
        if follow_up_to and not _ID_RE.match(follow_up_to):
            follow_up_to = ""

        comment = {
            "cid": cid,
            "index": len(comments) + 1,
            "status": "new",
            "comment": str(payload.get("comment", "")),
            "createdAt": created,
            "selection": sel,
            "previewUrl": preview_url,
            # Stored per comment as well as on the request: the panel matches
            # pins to the previewed project by this id, and matching on the id
            # (rather than on the shape of previewUrl) is what lets a project
            # previewed straight from its dev server keep its pins.
            "projectId": project_id,
            "sourceFile": source_file,
            "followUpTo": follow_up_to,
            # The user's own comment seeds the thread so the in-preview bubble
            # reads as a conversation from the first frame.
            "thread": [{"role": "user", "text": str(payload.get("comment", "")), "ts": created}],
        }
        if _TARGET and not project_root:
            comment["devServer"] = _TARGET
        comments.append(comment)
        _write_request(fp, req)

        return self._json(200, {
            "ok": True,
            "id": req["id"],
            "number": req["number"],
            "state": req["state"],
            "cid": cid,
            "index": comment["index"],
            "label": f"{req['number']}.{comment['index']}",
            "commentCount": len(comments),
            "savedTo": str(fp),
        })

    def _h_send(self, qs: dict) -> None:
        """Seal a draft request and mark every comment as sent (seal-on-send).

        After this the request never accepts new comments, so the next captured
        comment opens a fresh draft even while this batch is still in flight.
        """
        rid = (qs.get("id") or [""])[0]
        if not rid or not _ID_RE.match(rid):
            return self._json(400, {"error": "valid id required"})
        fp = QUEUE_DIR / f"{rid}.json"
        if not fp.is_file():
            return self._json(404, {"error": "not found"})
        req = _read_request(fp)
        if req is None:
            return self._json(500, {"error": "request unreadable"})
        comments = req.get("comments") or []
        if not comments:
            return self._json(400, {"error": "request has no comments"})
        if not _is_draft(req):
            return self._json(200, {"ok": True, "already": True, "request": _summarize(req)})
        req["state"] = "sent"
        req["sentAt"] = _now_iso()
        for c in comments:
            if c.get("status") == "new":
                c["status"] = "sent"
        _write_request(fp, req)
        return self._json(200, {"ok": True, "request": _summarize(req)})

    def _h_delete_comment(self, qs: dict) -> None:
        """Drop a single comment from a DRAFT request (undo a mis-click).

        Refused once the request is sent — the agent already has that batch.
        """
        rid = (qs.get("id") or [""])[0]
        cid = (qs.get("cid") or [""])[0]
        if not rid or not _ID_RE.match(rid) or not cid or not _ID_RE.match(cid):
            return self._json(400, {"error": "valid id and cid required"})
        fp = QUEUE_DIR / f"{rid}.json"
        if not fp.is_file():
            return self._json(404, {"error": "not found"})
        req = _read_request(fp)
        if req is None:
            return self._json(500, {"error": "request unreadable"})
        if not _is_draft(req):
            return self._json(409, {"error": "request already sent — cannot remove comments"})
        comments = req.get("comments") or []
        kept = [c for c in comments if c.get("cid") != cid]
        if len(kept) == len(comments):
            return self._json(404, {"error": "comment not found"})
        for n, c in enumerate(kept, start=1):
            c["index"] = n          # keep sub-numbering contiguous (3.1, 3.2, …)
        req["comments"] = kept
        # An emptied draft is noise in the rail — drop the request with it.
        if not kept:
            try:
                fp.unlink()
            except OSError as exc:
                return self._json(500, {"error": str(exc)})
            return self._json(200, {"ok": True, "id": rid, "removedRequest": True})
        _write_request(fp, req)
        return self._json(200, {"ok": True, "id": rid, "cid": cid, "request": _summarize(req)})


    def _h_clear(self, qs: dict) -> None:
        rid = (qs.get("id") or [""])[0]
        if not rid or not _ID_RE.match(rid):
            return self._json(400, {"error": "valid id required"})
        src = QUEUE_DIR / f"{rid}.json"
        if not src.exists():
            return self._json(404, {"error": "not found"})
        dst = HANDLED_DIR / f"{rid}.json"
        try:
            src.replace(dst)
        except OSError as exc:
            return self._json(500, {"error": str(exc)})
        return self._json(200, {"ok": True, "id": rid})

    def _h_delete(self, qs: dict) -> None:
        """Permanently delete a request (from queue/ or handled/). Unlike /clear
        (which archives to handled/), this removes the file entirely."""
        rid = (qs.get("id") or [""])[0]
        if not rid or not _ID_RE.match(rid):
            return self._json(400, {"error": "valid id required"})
        removed = False
        for d in (QUEUE_DIR, HANDLED_DIR):
            fp = d / f"{rid}.json"
            if fp.exists():
                try:
                    fp.unlink()
                    removed = True
                except OSError as exc:
                    return self._json(500, {"error": str(exc)})
        if not removed:
            return self._json(404, {"error": "not found"})
        return self._json(200, {"ok": True, "id": rid, "deleted": True})

    # ---- project registry handlers ----
    def _h_projects_list(self) -> None:
        active = _active_project()
        serving = bool(_ROOT and active and str(Path(active["path"]).resolve()) == _ROOT)
        # Classification is computed per request, never stored: a folder becomes
        # static the moment its build lands in dist/, and a stale flag would keep
        # showing "needs a dev server" for something that now previews fine.
        out = []
        for p in _CFG["projects"]:
            row = dict(p)
            root = _valid_root(p["path"])
            row.update(_classify_project(root) if root else {
                "needsDevServer": False, "devCommand": "",
                "unbundledEntry": "", "hasEntry": False,
            })
            row["devRunning"] = _dev_proc_alive(p["id"])
            # The injecting proxy's port is ephemeral: it lives and dies with this
            # backend, so it is resolved live here rather than persisted. A saved
            # port would be guaranteed dead after a restart.
            live = _DEV_PROCS.get(p["id"]) or {}
            if live.get("proxyUrl"):
                row["previewUrl"] = live["proxyUrl"]
                row["devUrl"] = live.get("url", "")
            out.append(row)
        return self._json(200, {
            "projects": out,
            "activeId": _CFG["activeId"],
            "serving": serving,
            "repoUrl": REPO_URL,
            "version": VERSION,
        })

    def _h_dev_server_start(self, qs: dict) -> None:
        """Start the project's own dev server and point the preview at it."""
        pid = (qs.get("id") or [""])[0]
        proj = next((p for p in _CFG["projects"] if p["id"] == pid), None)
        if proj is None:
            return self._json(404, {"error": "project not found"})
        root = _valid_root(proj["path"])
        if root is None:
            return self._json(400, {"error": f"folder no longer readable: {proj['path']}"})

        # Already running elsewhere (started by hand in a terminal)? Adopt it
        # rather than starting a second one on another port.
        adopted = _auto_dev_server(root)
        if adopted:
            # Front it with the injecting proxy as well — a server the user started
            # serves its own HTML, so without this the overlay never loads and
            # select-to-edit is missing on exactly the projects that need it most.
            framed = _front_with_proxy(pid, adopted)
            # NOT persisted: the proxy port dies with this backend, so a saved URL
            # is guaranteed dead after a restart. _h_projects_list resolves the live
            # one per request instead.
            return self._json(200, {"ok": True, "url": framed, "devUrl": adopted,
                                    "adopted": True, "injected": framed != adopted,
                                    "project": proj})

        res = _start_dev_proc(pid, root)
        if not res.get("ok"):
            return self._json(200, res)          # 200: the error text IS the answer
        # Likewise not persisted — see above.
        return self._json(200, {**res, "project": proj})

    def _h_dev_server_stop(self, qs: dict) -> None:
        """Stop a dev server WE started and revert the preview to serving from disk.

        A server the user started themselves is left running — Design Tweak did not
        start it, so killing it would be a surprise. Its URL is just forgotten.
        """
        pid = (qs.get("id") or [""])[0]
        proj = next((p for p in _CFG["projects"] if p["id"] == pid), None)
        if proj is None:
            return self._json(404, {"error": "project not found"})
        stopped = _stop_dev_proc(pid)
        proj.pop("previewUrl", None)
        _save_cfg(_CFG)
        return self._json(200, {"ok": True, "stopped": stopped, "project": proj})


    def _h_projects_add(self) -> None:
        data = self._read_body()
        raw = str(data.get("path", "")).strip()
        root = _valid_root(raw)
        if root is None:
            return self._json(400, {"error": f"not a readable folder: {raw}"})
        # Optional dev-server URL. A project is always identified by its FOLDER —
        # that is where the agent edits — and the URL only changes how it is
        # previewed: framed directly instead of proxied from disk. Framework
        # projects need that because this backend cannot proxy a WebSocket, so
        # HMR dies behind the proxy.
        preview_url = str(data.get("previewUrl", "") or "").strip().rstrip("/")
        if preview_url and not _valid_target(preview_url):
            return self._json(400, {
                "error": "dev server URL must be http://localhost:PORT or http://127.0.0.1:PORT",
            })
        for p in _CFG["projects"]:
            if str(Path(p["path"]).resolve()) == str(root):
                if preview_url and p.get("previewUrl", "") != preview_url:
                    p["previewUrl"] = preview_url
                    _save_cfg(_CFG)
                    return self._json(200, {"ok": True, "project": p, "existing": True,
                                            "updated": "previewUrl"})
                return self._json(200, {"ok": True, "project": p, "existing": True})
        proj = {"id": uuid.uuid4().hex[:8], "path": str(root), "name": root.name}

        # No URL typed? Look for a dev server already serving this folder. Only
        # an UNAMBIGUOUS match is attached (exactly one candidate serving HTML) —
        # with several running, silently picking one would point the preview at
        # the wrong app, so they are returned for the user to choose instead.
        detected = []
        if preview_url:
            proj["previewUrl"] = preview_url
        else:
            detected = _detect_dev_servers(root)
            auto = [c for c in detected if c["servesHtml"]]
            if len(auto) == 1:
                proj["previewUrl"] = auto[0]["url"]

        _CFG["projects"].append(proj)
        _save_cfg(_CFG)
        return self._json(200, {
            "ok": True,
            "project": proj,
            "detected": detected,
            "autoDetected": bool(not preview_url and proj.get("previewUrl")),
        })

    def _h_detect_dev_server(self, qs: dict) -> None:
        """Dev servers plausibly serving a project — for the UI's Detect button.

        Takes either `?id=<projectId>` or `?path=<folder>` so it works before a
        project is registered as well as after.
        """
        pid = (qs.get("id") or [""])[0]
        raw = (qs.get("path") or [""])[0]
        if pid:
            proj = next((p for p in _CFG["projects"] if p["id"] == pid), None)
            if proj is None:
                return self._json(404, {"error": "project not found"})
            raw = proj["path"]
        root = _valid_root(raw)
        if root is None:
            return self._json(400, {"error": f"not a readable folder: {raw}"})
        candidates = _detect_dev_servers(root)
        html = [c for c in candidates if c["servesHtml"]]
        return self._json(200, {
            "ok": True,
            "root": str(root),
            "candidates": candidates,
            # Only offered when unambiguous, matching add-time behaviour.
            "suggested": html[0]["url"] if len(html) == 1 else "",
        })


    def _h_projects_preview_url(self) -> None:
        """Set or clear a registered project's dev-server URL.

        Sending an empty `previewUrl` reverts the project to proxied-from-disk,
        which is the right move when the dev server is not running: the static
        proxy still renders something, where a dead URL frames an error page.
        """
        data = self._read_body()
        pid = str(data.get("id", ""))
        proj = next((p for p in _CFG["projects"] if p["id"] == pid), None)
        if proj is None:
            return self._json(404, {"error": "project not found"})
        url = str(data.get("previewUrl", "") or "").strip().rstrip("/")
        if url and not _valid_target(url):
            return self._json(400, {
                "error": "dev server URL must be http://localhost:PORT or http://127.0.0.1:PORT",
            })
        if url:
            proj["previewUrl"] = url
        else:
            proj.pop("previewUrl", None)
        _save_cfg(_CFG)
        return self._json(200, {"ok": True, "project": proj})

    def _h_projects_select(self) -> None:
        """Connect a registered project: make it the active served root."""
        data = self._read_body()
        pid = str(data.get("id", ""))
        proj = next((p for p in _CFG["projects"] if p["id"] == pid), None)
        if proj is None:
            return self._json(404, {"error": "project not found"})
        root = _valid_root(proj["path"])
        if root is None:
            return self._json(400, {"error": f"folder no longer readable: {proj['path']}"})
        global _ROOT, _TARGET
        _ROOT = str(root)
        _TARGET = ""
        _CFG["activeId"] = pid
        _save_cfg(_CFG)
        return self._json(200, {"ok": True, "project": proj, "proxyUrl": PROXY_PUBLIC_BASE})

    def _h_projects_remove(self) -> None:
        """Remove a project from the registry (does not touch the folder on disk)."""
        data = self._read_body()
        pid = str(data.get("id", ""))
        proj = next((p for p in _CFG["projects"] if p["id"] == pid), None)
        if proj is None:
            return self._json(404, {"error": "project not found"})
        _CFG["projects"] = [p for p in _CFG["projects"] if p["id"] != pid]
        global _ROOT
        if _CFG.get("activeId") == pid:
            _CFG["activeId"] = ""
            _ROOT = ""
        _save_cfg(_CFG)
        return self._json(200, {"ok": True, "id": pid})

    def _h_pick_folder(self) -> None:
        """Open the native macOS folder chooser (osascript) and return the
        picked absolute path. The backend runs on the user's Mac, so the
        dialog appears locally — the browser never needs the path."""
        import subprocess
        import sys as _sys
        if _sys.platform != "darwin":
            return self._json(501, {"error": "native picker is macOS-only"})
        if not _PICK_LOCK.acquire(blocking=False):
            return self._json(409, {"error": "a folder picker is already open"})
        try:
            script = (
                'tell application "System Events" to activate\n'
                'POSIX path of (choose folder with prompt "Select a web app folder for Design Tweak")'
            )
            r = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=180,
            )
        except subprocess.TimeoutExpired:
            return self._json(408, {"error": "picker timed out"})
        except OSError as exc:
            return self._json(500, {"error": str(exc)})
        finally:
            _PICK_LOCK.release()
        if r.returncode != 0:
            err = (r.stderr or "").strip()
            if "-128" in err or "canceled" in err.lower():
                return self._json(200, {"ok": False, "canceled": True})
            return self._json(500, {"error": err[-200:] or "picker failed"})
        path = r.stdout.strip().rstrip("/")
        if not path:
            return self._json(200, {"ok": False, "canceled": True})
        return self._json(200, {"ok": True, "path": path})

    def _h_thread(self, qs: dict) -> None:
        """Append a progress note to a COMMENT's thread (or the request's).

        `POST /thread?id=<requestId>&cid=<commentId>` targets one comment — this
        is what the agent uses while working a batch, so each comment's bubble
        tracks its own progress. Omitting `cid` appends a request-level note.

        Body: {"role": "agent"|"user"|"system", "text": "...", "status": "done"?}
        `status` applies to the addressed comment. The request's own status is
        always derived from its comments, never stored.
        """
        rid = (qs.get("id") or [""])[0]
        cid = (qs.get("cid") or [""])[0]
        if not rid or not _ID_RE.match(rid):
            return self._json(400, {"error": "valid id required"})
        if cid and not _ID_RE.match(cid):
            return self._json(400, {"error": "invalid cid"})
        data = self._read_body()
        text = str(data.get("text", "")).strip()
        role = str(data.get("role", "agent")).strip() or "agent"
        if role not in ("agent", "user", "system"):
            role = "agent"
        new_status = str(data.get("status", "")).strip()
        if not text and not new_status:
            return self._json(400, {"error": "text or status required"})

        fp = _find_request(rid)
        if fp is None:
            return self._json(404, {"error": "not found"})
        req = _read_request(fp)
        if req is None:
            return self._json(500, {"error": "request unreadable"})

        entry = {"role": role, "text": text, "ts": _now_iso()}
        if cid:
            target = next((c for c in (req.get("comments") or []) if c.get("cid") == cid), None)
            if target is None:
                return self._json(404, {"error": f"comment {cid} not in request {rid}"})
            thread = target.get("thread")
            if not isinstance(thread, list):
                thread = []
            if text:
                thread.append(entry)
            target["thread"] = thread
            if new_status in _COMMENT_STATUSES:
                target["status"] = new_status
        else:
            thread = req.get("thread")
            if not isinstance(thread, list):
                thread = []
            if text:
                thread.append(entry)
            req["thread"] = thread
            # A request-level `done` fans out to every comment, so an agent that
            # reports once for the whole batch still resolves the sub-items.
            if new_status == "done":
                for c in req.get("comments") or []:
                    c["status"] = "done"

        # Any agent activity means this batch is in flight — normalise `state` so
        # it can never contradict the comments. Two drifts to close: an agent
        # writing its own `state` value (which used to make a worked request read
        # back as an unsent draft), and an agent reporting progress on a request
        # that was never formally sealed. A bare progress note is enough evidence:
        # the agent only ever sees a request that was handed to it.
        agent_activity = role in ("agent", "system")
        worked = any(c.get("status") != "new" for c in (req.get("comments") or []))
        if req.get("state") not in ("draft", "sent") or (
            req.get("state") == "draft" and (worked or agent_activity)
        ):
            req["state"] = "sent"
            if not req.get("sentAt"):
                req["sentAt"] = _now_iso()

        try:
            _write_request(fp, req)
        except OSError as exc:
            return self._json(500, {"error": str(exc)})
        return self._json(200, {
            "ok": True, "id": rid, "cid": cid,
            "status": _request_status(req),
            "request": _summarize(req),
        })

    def _h_self_update(self) -> None:
        """Pull the latest app code from its declared git repo into the installed
        app dir. UI changes apply on refresh; backend changes need a gateway restart."""
        import shutil
        import subprocess
        import tempfile
        if not REPO_URL:
            return self._json(400, {"error": "no 'repository' declared in app.json"})
        with tempfile.TemporaryDirectory() as td:
            clone_dir = str(Path(td) / "app")
            try:
                r = subprocess.run(
                    ["git", "clone", "--depth", "1", REPO_URL, clone_dir],
                    capture_output=True, text=True, timeout=60,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                return self._json(502, {"error": f"git clone failed: {exc}"})
            if r.returncode != 0:
                return self._json(502, {"error": "git clone failed: " + r.stderr[-300:]})
            src = Path(clone_dir)
            try:
                new_version = json.loads((src / "app.json").read_text()).get("version", "?")
            except (OSError, ValueError):
                return self._json(502, {"error": "cloned repo has no valid app.json"})
            copied = []
            for item in ("app.json", "README.md", "backend", "ui", "skills", "inject", "plugins"):
                s = src / item
                if not s.exists():
                    continue
                dst = APP_DIR / item
                try:
                    if s.is_dir():
                        shutil.copytree(s, dst, dirs_exist_ok=True)
                    else:
                        shutil.copy2(s, dst)
                    copied.append(item)
                except OSError as exc:
                    return self._json(500, {"error": f"copy failed for {item}: {exc}"})
        return self._json(200, {
            "ok": True,
            "version": new_version,
            "copied": copied,
            "note": "UI updates on refresh; backend changes require a gateway restart.",
        })

    # ---- source + proxy handlers ----
    def _h_set_source(self) -> None:
        """Set the previewed app source: a folder path (served directly) or a
        localhost dev-server URL (reverse-proxied). Empty value clears."""
        data = self._read_body()
        val = str(data.get("value", data.get("url", ""))).strip()
        global _ROOT, _TARGET
        if not val:
            _ROOT = ""
            _TARGET = ""
            return self._json(200, {"ok": True, "mode": "cleared", "proxyUrl": PROXY_PUBLIC_BASE})
        if val.lower().startswith(("http://", "https://")):
            if not _valid_target(val):
                return self._json(400, {
                    "error": "URL must be http://localhost:PORT or http://127.0.0.1:PORT",
                })
            _TARGET = val.rstrip("/")
            _ROOT = ""
            return self._json(200, {
                "ok": True, "mode": "url", "target": _TARGET, "proxyUrl": PROXY_PUBLIC_BASE,
            })
        root = _valid_root(val)
        if root is None:
            return self._json(400, {"error": f"not a readable folder: {val}"})
        _ROOT = str(root)
        _TARGET = ""
        return self._json(200, {
            "ok": True, "mode": "folder", "root": _ROOT, "proxyUrl": PROXY_PUBLIC_BASE,
        })

    def _h_inject(self) -> None:
        try:
            js = INJECT_FILE.read_bytes()
        except OSError:
            return self._send_raw(404, "application/javascript", b"// overlay not found")
        return self._send_raw(200, "application/javascript; charset=utf-8", js)

    def _h_proxy(self, sub: str) -> None:
        # Multi-project: /proxy/<projectId>/... serves ANY registered project —
        # all projects are simultaneously live; switching is just a URL change.
        rel = sub.lstrip("/")
        first = rel.split("/", 1)[0] if rel else ""
        proj = next((p for p in _CFG["projects"] if p["id"] == first), None)
        if proj is not None:
            root = _valid_root(proj["path"])
            if root is None:
                return self._send_raw(
                    404, "text/html; charset=utf-8",
                    b"<h3 style='font:14px system-ui;padding:24px'>Project folder no longer readable.</h3>",
                )
            rest = rel.split("/", 1)[1] if "/" in rel else ""
            return self._h_serve_root(
                "/" + rest, str(root), PROXY_PUBLIC_BASE + proj["id"] + "/"
            )
        # Legacy single-root + dev-server URL modes.
        if _ROOT:
            return self._h_serve_root(sub, _ROOT, PROXY_PUBLIC_BASE)
        if _TARGET:
            return self._h_proxy_upstream(sub)
        return self._send_raw(
            503, "text/html; charset=utf-8",
            b"<h3 style='font:14px system-ui;padding:24px'>No project selected. "
            b"Pick a web app in the Design Tweak panel.</h3>",
        )

    def _h_serve_root(self, sub: str, root_str: str, base: str) -> None:
        """Serve a file from a project folder (static hosting)."""
        root = Path(root_str)
        rel = sub.lstrip("/")
        target = (root / rel).resolve() if rel else root
        try:
            target.relative_to(root)  # path-traversal guard
        except ValueError:
            return self._send_raw(403, "text/plain", b"forbidden")
        if target.is_dir():
            entry = _find_entry(target)
            if entry is None:
                return self._h_no_entry(root, target, base)
            target = entry
        if not target.is_file():
            return self._h_no_entry(root, target, base, missing=rel)
        try:
            data = target.read_bytes()
        except OSError as exc:
            return self._send_raw(500, "text/plain", str(exc).encode())
        ctype = _guess_ctype(target)
        if "text/html" in ctype:
            # A bundler template cannot render statically — bail out with an
            # explanation rather than a page guaranteed to come up blank.
            entry = _unbundled_entry(data)
            if entry:
                return self._h_needs_dev_server(root, target, entry)
            # <base> must point at the SERVED FILE's own directory, not the
            # project root — otherwise an index.html living in public/ or app/
            # resolves its relative assets one level too high and renders blank.
            try:
                sub_dir = target.parent.relative_to(root).as_posix()
            except ValueError:
                sub_dir = "."
            html_base = base if sub_dir in ("", ".") else base + sub_dir + "/"
            data = _rewrite_html(data, html_base)
            ctype = "text/html; charset=utf-8"
        return self._send_raw(200, ctype, data)

    def _h_needs_dev_server(self, root: Path, page: Path, entry: str) -> None:
        """The page is a bundler template — explain that, don't render a blank.

        `<script type="module" src="…/main.tsx">` needs Vite (or equivalent) to
        transform it. Served from disk the browser gets TypeScript, refuses to
        execute it, and leaves an empty `#root`: HTTP 200, valid HTML, nothing on
        screen. Silent success is the worst outcome here, so say what is wrong and
        name the two ways out.
        """
        built = [d for d in ("dist", "build", "out", ".output/public") if (root / d).is_dir()]
        built_hint = (
            "<p>This project has a <code>" + "</code>, <code>".join(built) +
            "</code> folder — if that is a finished build, register THAT folder "
            "instead and it will preview from disk.</p>"
        ) if built else ""
        page_rel = page.name
        page_disp = _html.escape(page_rel)
        entry_disp = _html.escape(entry)
        body = (
            f"<h3>{page_disp} needs a dev server</h3>"
            f"<p>Its only script is <code>{entry_disp}</code> — TypeScript/JSX, which "
            "the browser cannot run. A bundler has to transform it, so serving these "
            "files from disk renders an empty page.</p>"
            "<p><b>Start this project's dev server</b> (<code>npm run dev</code>), then "
            "press <b>Dev server</b> in the bar below the preview. Design Tweak will "
            "frame it directly, hot reload keeps working, and select-to-edit still "
            "works — add <code>vite-plugin-kiro-source</code> for exact "
            "<code>file:line:col</code> targeting.</p>"
            f"{built_hint}"
        )
        page_html = (
            "<!doctype html><meta charset='utf-8'>"
            "<style>"
            "body{font:14px/1.6 system-ui,-apple-system,sans-serif;padding:28px 32px;"
            "color:#e6e6e6;background:#151517;max-width:56ch}"
            "h3{margin:0 0 12px;font-size:15px;font-weight:600}"
            "code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;"
            "background:#26262a;padding:1px 5px;border-radius:4px}"
            "p{margin:0 0 10px}b{color:#fff}"
            "</style>"
            f"{body}"
        )
        # 200, not an error: the file was found and read fine. The page IS the
        # answer, and a 4xx here would trip the panel's own error handling.
        return self._send_raw(200, "text/html; charset=utf-8", page_html.encode("utf-8"))

    def _h_no_entry(self, root: Path, folder: Path, base: str, missing: str = "") -> None:
        """404 page that explains WHY nothing rendered and offers what we found.

        Replaces a bare "Not found in project folder." — the common cause is a
        project with no top-level index.html (site lives in public/ or dist/, or
        the app is nested in a subfolder, or it isn't a static site at all)."""
        scan_from = folder if folder.is_dir() else root
        candidates = _scan_html(scan_from)
        if not candidates and scan_from != root:
            # An empty subfolder tells the user nothing — widen to the project root
            # so the suggestions are actually actionable.
            scan_from = root
            candidates = _scan_html(scan_from)
        try:
            prefix = scan_from.relative_to(root).as_posix()
        except ValueError:
            prefix = ""
        prefix = "" if prefix in ("", ".") else prefix + "/"

        if missing:
            head = f"<code>{_html.escape(missing)}</code> was not found in this project."
        else:
            head = f"No <code>index.html</code> in <code>{_html.escape(str(scan_from))}</code>."

        if candidates:
            links = "".join(
                f'<li><a href="{_html.escape(base + prefix + c)}">{_html.escape(prefix + c)}</a></li>'
                for c in candidates
            )
            body = (
                "<p>Design Tweak serves the folder as a static site and looks for an "
                "entry <code>index.html</code>. These HTML files are in the project — "
                "click one to preview it:</p>"
                f"<ul>{links}</ul>"
                "<p class='hint'>If the right entry point isn't listed, register the "
                "<em>subfolder</em> that contains it (<code>+ load new app</code>), or point "
                "Design Tweak at a running dev server URL for framework projects.</p>"
            )
        else:
            body = (
                "<p>No HTML files were found here, so there is nothing to serve "
                "statically. This usually means the project is a framework app "
                "(React / Vite / Next) that needs its dev server, or the previewable "
                "site lives in a subfolder that wasn't registered.</p>"
                "<p class='hint'>Fix it by either registering the subfolder that "
                "contains <code>index.html</code>, running the project's build "
                "(<code>npm run build</code>) and registering <code>dist/</code>, or "
                "starting <code>npm run dev</code> and pointing Design Tweak at "
                "<code>http://localhost:PORT</code>.</p>"
            )

        page = (
            "<!doctype html><meta charset='utf-8'>"
            "<style>"
            "body{font:14px/1.6 system-ui,-apple-system,sans-serif;padding:28px 32px;"
            "color:#e6e6e6;background:#151517}"
            "h3{margin:0 0 12px;font-size:15px;font-weight:600}"
            "code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;"
            "background:#26262a;padding:1px 5px;border-radius:4px}"
            "ul{margin:12px 0;padding-left:20px}li{margin:3px 0}"
            "a{color:#7cc4ff}.hint{color:#9a9aa2;font-size:13px}"
            "</style>"
            f"<h3>{head}</h3>{body}"
        )
        return self._send_raw(404, "text/html; charset=utf-8", page.encode("utf-8"))

    def _h_proxy_upstream(self, sub: str) -> None:
        """Reverse-proxy a localhost dev server (Vite/HMR projects)."""
        query = urlparse(self.path).query
        path = sub if sub.startswith("/") else "/" + sub
        upstream = _TARGET + path + (("?" + query) if query else "")
        try:
            req = urllib.request.Request(
                upstream, headers={"User-Agent": "KiroClaw-SelectToEdit-Proxy"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 (localhost only)
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                body = resp.read()
        except urllib.error.HTTPError as exc:
            return self._send_raw(exc.code, "text/plain", f"upstream {exc.code}".encode())
        except (urllib.error.URLError, OSError, ValueError) as exc:
            msg = (
                f"<h3 style='font:14px system-ui;padding:24px'>Can't reach "
                f"<code>{_TARGET}</code> — is your dev server running on that port?"
                f"</h3><p style='font:12px system-ui;padding:0 24px;color:#888'>{exc}</p>"
            )
            return self._send_raw(502, "text/html; charset=utf-8", msg.encode())
        if "text/html" in ctype.lower():
            body = _rewrite_html(body)
            ctype = "text/html; charset=utf-8"
        return self._send_raw(200, ctype, body)

    def _send_raw(self, code: int, ctype: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- helpers ----
    def _json(self, code: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[{APP_NAME}] listening on http://127.0.0.1:{PORT}  data={DATA_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
