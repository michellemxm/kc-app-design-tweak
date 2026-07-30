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

VERSION = "0.6.0"
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


def _next_number() -> int:
    _CFG["counter"] = int(_CFG.get("counter", 0)) + 1
    _save_cfg(_CFG)
    return _CFG["counter"]


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
        "count": len(elements),
        "mode": sel.get("mode", "single"),
        "previewUrl": c.get("previewUrl", ""),
        "sourceFile": c.get("sourceFile", ""),
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

    Preview URLs look like `/apps/<app>/api/proxy/<projectId>/<rel>`, so the
    project id and the served file both fall out of the path.
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
# Entry-point resolution.
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


def _rewrite_html(body: bytes, base: str = PROXY_PUBLIC_BASE) -> bytes:
    """Inject <base> (so relative assets resolve back through the proxy) and the
    Select-to-Edit overlay script (so no manual wiring is needed)."""
    try:
        html = body.decode("utf-8", "replace")
    except (UnicodeDecodeError, AttributeError):
        return body
    base_tag = f'<base href="{base}">'
    inject_tag = f'<script src="{INJECT_PUBLIC}"></script>'
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
        proj, rest = _proj_for_preview(preview_url)
        project_id = proj["id"] if proj else ""

        # Resolve the source file for THIS comment (per-comment, because a batch
        # can span several pages of the same app).
        if proj is not None:
            project_root = proj["path"]
            source_file = str(Path(project_root) / (rest or "index.html"))
        elif _ROOT:
            project_root = _ROOT
            source_file = str(Path(_ROOT) / (rest or "index.html"))
        else:
            project_root = ""
            source_file = ""

        # Find or open the draft for this project.
        fp = _open_draft_file(project_id)
        if fp is None:
            rid = _new_id()
            req = {
                "type": "visual_edit_batch",
                "id": rid,
                "number": _next_number(),
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
        return self._json(200, {
            "projects": _CFG["projects"],
            "activeId": _CFG["activeId"],
            "serving": serving,
            "repoUrl": REPO_URL,
            "version": VERSION,
        })

    def _h_projects_add(self) -> None:
        data = self._read_body()
        raw = str(data.get("path", "")).strip()
        root = _valid_root(raw)
        if root is None:
            return self._json(400, {"error": f"not a readable folder: {raw}"})
        for p in _CFG["projects"]:
            if str(Path(p["path"]).resolve()) == str(root):
                return self._json(200, {"ok": True, "project": p, "existing": True})
        proj = {"id": uuid.uuid4().hex[:8], "path": str(root), "name": root.name}
        _CFG["projects"].append(proj)
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
