#!/usr/bin/env python3
"""Refresh GitHub App installation tokens into the OneCLI vault.

For each app credential file in ~/.nanoclaw-github-apps/<name>.json (created
by scripts/github-app-manifest-server.py), mint a fresh installation access
token (valid 60 min) and upsert it as a OneCLI generic secret named
"github-<name>" with host pattern api.github.com. Agents assigned that secret
get it injected by the gateway at request time; the token itself never lands
in a container.

Run from a systemd user timer every ~45 minutes (see
~/.config/systemd/user/nanoclaw-github-tokens.timer). Idempotent; safe to run
manually.
"""
import base64
import glob
import json
import os
import subprocess
import sys
import time
import urllib.request

APPS_DIR = os.path.expanduser("~/.nanoclaw-github-apps")


def b64(data: bytes) -> bytes:
    return base64.urlsafe_b64encode(data).rstrip(b"=")


def mint_jwt_openssl(app_id: int, pem_path: str) -> str:
    now = int(time.time())
    header = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload = b64(json.dumps({"iat": now - 60, "exp": now + 540, "iss": app_id}).encode())
    signing_input = header + b"." + payload
    sig = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", pem_path],
        input=signing_input,
        capture_output=True,
        check=True,
    ).stdout
    return (signing_input + b"." + b64(sig)).decode()


def gh_api(url: str, token: str, method: str = "GET") -> object:
    req = urllib.request.Request(
        url, method=method,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.load(res)


def onecli(*args: str) -> object:
    out = subprocess.run(["onecli", *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"onecli {' '.join(args[:2])} failed: {out.stdout} {out.stderr}")
    return json.loads(out.stdout) if out.stdout.strip() else {}


def existing_secrets() -> dict[str, str]:
    listed = onecli("secrets", "list")
    data = listed.get("data", listed) if isinstance(listed, dict) else listed
    return {s["name"]: s["id"] for s in data}


def main() -> int:
    failures = 0
    secrets = existing_secrets()
    for path in sorted(glob.glob(os.path.join(APPS_DIR, "*.json"))):
        name = os.path.splitext(os.path.basename(path))[0]
        try:
            creds = json.load(open(path))
            pem_path = path.replace(".json", ".pem")
            if not os.path.exists(pem_path):
                fd = os.open(pem_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(creds["pem"])
            jwt = mint_jwt_openssl(creds["id"], pem_path)
            installations = gh_api("https://api.github.com/app/installations", jwt)
            if not installations:
                print(f"{name}: no installations, skipping")
                continue
            inst_id = installations[0]["id"]
            tok = gh_api(f"https://api.github.com/app/installations/{inst_id}/access_tokens", jwt, method="POST")
            token, expires = tok["token"], tok["expires_at"]
            secret_name = f"github-{name}"
            if secret_name in secrets:
                onecli("secrets", "update", "--id", secrets[secret_name], "--value", token)
            else:
                onecli(
                    "secrets", "create", "--name", secret_name, "--type", "generic",
                    "--value", token, "--host-pattern", "api.github.com",
                    "--header-name", "Authorization", "--value-format", "Bearer {value}",
                )
            print(f"{name}: refreshed (expires {expires})")
        except Exception as err:  # noqa: BLE001
            failures += 1
            print(f"{name}: FAILED — {err}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
