#!/usr/bin/env python3
"""One-click GitHub App creation via the app manifest flow.

Serves a pre-filled manifest form and catches GitHub's redirect to exchange
the temporary code for the app's credentials (id, PEM key, client secret).
Credentials are written to ~/.nanoclaw-github-apps/<name>.json (chmod 600).

Run:  python3 scripts/github-app-manifest-server.py <org> <app-name> [port]
Then open <public-base>/gh-manifest in a browser (routed here via the
Cloudflare tunnel's path rule) and click the button.

The manifest flow needs no pre-existing credential: the code→credentials
exchange (POST /app-manifests/{code}/conversions) is unauthenticated by
design. The server exits after a successful exchange.
"""
import json
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

ORG = sys.argv[1]
APP_NAME = sys.argv[2]
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8899
PUBLIC_BASE = os.environ.get("PUBLIC_BASE", "https://webhook.edna-ai.online")
OUT_DIR = os.path.expanduser("~/.nanoclaw-github-apps")

MANIFEST = {
    "name": APP_NAME,
    "url": PUBLIC_BASE,
    # GitHub requires hook_attributes.url whenever hook_attributes is present,
    # even with active: false. The URL is never called.
    "hook_attributes": {"url": f"{os.environ.get('PUBLIC_BASE', 'https://webhook.edna-ai.online')}/gh-manifest/hook", "active": False},
    "redirect_url": f"{PUBLIC_BASE}/gh-manifest/callback",
    "public": False,
    "default_permissions": {
        "contents": "write",
        "pull_requests": "write",
        "issues": "write",
        "actions": "write",
        "workflows": "write",
        "administration": "write",
        "checks": "write",
        "statuses": "write",
        "environments": "write",
        "secrets": "write",
        "organization_administration": "write",
        "members": "read",
    },
}

FORM_PAGE = f"""<!doctype html>
<html><head><title>Create GitHub App: {APP_NAME}</title></head>
<body style="font-family: sans-serif; max-width: 40em; margin: 4em auto;">
  <h1>Create GitHub App &ldquo;{APP_NAME}&rdquo; in {ORG}</h1>
  <p>This submits a pre-filled app manifest to GitHub. You will be asked to
  confirm on GitHub, then redirected back here automatically.</p>
  <form action="https://github.com/organizations/{ORG}/settings/apps/new" method="post">
    <input type="hidden" name="manifest" value='{json.dumps(MANIFEST).replace("'", "&#39;")}'>
    <button type="submit" style="font-size: 1.3em; padding: 0.5em 1.5em;">Create GitHub App &ldquo;{APP_NAME}&rdquo;</button>
  </form>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    exchanged = False

    def _send(self, status: int, body: str) -> None:
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/gh-manifest":
            self._send(200, FORM_PAGE)
            return
        if parsed.path == "/gh-manifest/callback":
            code = parse_qs(parsed.query).get("code", [None])[0]
            if not code:
                self._send(400, "<h1>Missing ?code=</h1>")
                return
            req = urllib.request.Request(
                f"https://api.github.com/app-manifests/{code}/conversions",
                method="POST",
                headers={"Accept": "application/vnd.github+json"},
            )
            try:
                with urllib.request.urlopen(req) as res:
                    creds = json.load(res)
            except Exception as err:  # noqa: BLE001
                self._send(502, f"<h1>Exchange failed</h1><pre>{err}</pre>")
                return
            os.makedirs(OUT_DIR, mode=0o700, exist_ok=True)
            out_path = os.path.join(OUT_DIR, f"{APP_NAME.lower()}.json")
            fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(creds, f, indent=2)
            Handler.exchanged = True
            self._send(200, f"""<!doctype html><html><body style="font-family: sans-serif; max-width: 40em; margin: 4em auto;">
              <h1>&#10004; GitHub App &ldquo;{creds.get("name")}&rdquo; created</h1>
              <p>App ID {creds.get("id")} (<a href="{creds.get("html_url")}">settings</a>).
              Credentials stored on the server. You can close this tab and return to the chat.</p>
            </body></html>""")
            print(f"EXCHANGED app_id={creds.get('id')} slug={creds.get('slug')} saved={out_path}", flush=True)
            return
        self._send(404, "<h1>Not found</h1>")

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving manifest form for {APP_NAME} ({ORG}) on 127.0.0.1:{PORT} — open {PUBLIC_BASE}/gh-manifest", flush=True)
    while not Handler.exchanged:
        server.handle_request()
    print("Done — credentials captured, exiting.", flush=True)
