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

Delivery model: this process cannot call the agent directly (separate process).
Instead it writes the structured payload to the app data queue dir; the bundled
`visual-edit` skill teaches the agent to read + act on it. This is the spec's
sanctioned "well-known file the agent watches" fallback.
"""

from __future__ import annotations

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

VERSION = "0.3.0"
PORT = int(os.environ.get("PORT", 9110))
APP_NAME = os.environ.get("KIROCLAW_APP_NAME", "poke-and-prose")

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

# Resolve the app data dir. KiroClaw sets an env for it; fall back to the
# documented default location under ~/.kiroclaw/apps/<name>/data.
_DATA_ENV = (
    os.environ.get("KIROCLAW_APP_DATA_DIR")
    or os.environ.get("KIROCLAW_APP_DATA")
    or ""
)
if _DATA_ENV:
    DATA_DIR = Path(_DATA_ENV).expanduser().resolve()
else:
    DATA_DIR = (
        Path(os.path.expanduser("~")) / ".kiroclaw" / "apps" / APP_NAME / "data"
    ).resolve()

QUEUE_DIR = DATA_DIR / "queue"
HANDLED_DIR = DATA_DIR / "handled"
QUEUE_DIR.mkdir(parents=True, exist_ok=True)
HANDLED_DIR.mkdir(parents=True, exist_ok=True)

MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MB cap on a single payload
_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")  # queue file id safety


def _new_id() -> str:
    return f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _pending_files() -> list[Path]:
    return sorted(QUEUE_DIR.glob("*.json"))


def _summarize(payload: dict) -> dict:
    sel = payload.get("selection") or {}
    elements = sel.get("elements") or []
    return {
        "id": payload.get("id", ""),
        "createdAt": payload.get("createdAt", ""),
        "comment": payload.get("comment", ""),
        "mode": sel.get("mode", "single"),
        "count": len(elements),
        "previewUrl": payload.get("previewUrl", ""),
    }


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


_CTYPE_OVERRIDES = {
    ".mjs": "text/javascript",
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


def _rewrite_html(body: bytes) -> bytes:
    """Inject <base> (so relative assets resolve back through the proxy) and the
    Select-to-Edit overlay script (so no manual wiring is needed)."""
    try:
        html = body.decode("utf-8", "replace")
    except (UnicodeDecodeError, AttributeError):
        return body
    base_tag = f'<base href="{PROXY_PUBLIC_BASE}">'
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
                pending = []
                for fp in _pending_files():
                    try:
                        pending.append(_summarize(json.loads(fp.read_text("utf-8"))))
                    except (OSError, ValueError):
                        continue
                return self._json(200, {"pending": pending})
            if route == "/latest":
                files = _pending_files()
                if not files:
                    return self._json(200, {})
                try:
                    return self._json(200, json.loads(files[-1].read_text("utf-8")))
                except (OSError, ValueError) as exc:
                    return self._json(500, {"error": str(exc)})
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
            if route in ("/source", "/target"):
                return self._h_set_source()
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
        payload = self._read_body()
        if payload.get("type") != "visual_edit_request":
            return self._json(400, {"error": "type must be 'visual_edit_request'"})
        sel = payload.get("selection") or {}
        if not isinstance(sel, dict) or not sel.get("elements"):
            return self._json(400, {"error": "selection.elements is required"})

        rid = payload.get("id") or _new_id()
        if not _ID_RE.match(str(rid)):
            rid = _new_id()
        payload["id"] = rid
        payload.setdefault("createdAt", _now_iso())

        # Stamp project context so the agent doesn't have to search for the source.
        if _ROOT:
            payload["projectRoot"] = _ROOT
            pu = str(payload.get("previewUrl", ""))
            marker = "/api/proxy/"
            i = pu.find(marker)
            rel = pu[i + len(marker):].split("?")[0].split("#")[0] if i != -1 else ""
            payload["sourceFile"] = str(Path(_ROOT) / (rel or "index.html"))
        elif _TARGET:
            payload["projectRoot"] = ""
            payload["devServer"] = _TARGET

        out = QUEUE_DIR / f"{rid}.json"
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return self._json(200, {"ok": True, "id": rid, "savedTo": str(out)})

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
        if _ROOT:
            return self._h_serve_root(sub)
        if _TARGET:
            return self._h_proxy_upstream(sub)
        return self._send_raw(
            503, "text/html; charset=utf-8",
            b"<h3 style='font:14px system-ui;padding:24px'>No project selected. "
            b"Enter a folder path (or a localhost dev-server URL) and click "
            b"<b>View</b> in the Select to Edit panel.</h3>",
        )

    def _h_serve_root(self, sub: str) -> None:
        """Serve a file from the configured project folder (static hosting)."""
        root = Path(_ROOT)
        rel = sub.lstrip("/")
        target = (root / rel).resolve() if rel else root
        try:
            target.relative_to(root)  # path-traversal guard
        except ValueError:
            return self._send_raw(403, "text/plain", b"forbidden")
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            return self._send_raw(
                404, "text/html; charset=utf-8",
                b"<h3 style='font:14px system-ui;padding:24px'>Not found in project folder.</h3>",
            )
        try:
            data = target.read_bytes()
        except OSError as exc:
            return self._send_raw(500, "text/plain", str(exc).encode())
        ctype = _guess_ctype(target)
        if "text/html" in ctype:
            data = _rewrite_html(data)
            ctype = "text/html; charset=utf-8"
        return self._send_raw(200, ctype, data)

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
