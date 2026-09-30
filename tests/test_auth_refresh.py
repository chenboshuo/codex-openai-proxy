"""
when access_token expires within five minutes -> refresh it before authenticated use        ✓
when concurrent requests observe one rotating refresh_token -> send exactly one refresh    ✓
when OAuth omits id_token -> preserve it while persisting rotated tokens and last_refresh   ✓

Fix: serialize proactive OAuth refreshes and atomically persist the returned token set.
Test: tests/test_auth_refresh.py::test_expired_auth_is_refreshed_once_and_persisted ✅
"""

from __future__ import annotations

from base64 import urlsafe_b64encode
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
from threading import Thread
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"


def _expired_access_token() -> str:
    header = urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=")
    payload = urlsafe_b64encode(
        json.dumps({"exp": int(time.time()) - 60}).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.signature"


def test_expired_auth_is_refreshed_once_and_persisted(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "tokens": {
                    "access_token": _expired_access_token(),
                    "refresh_token": "old-refresh-token",
                    "id_token": "preserved-id-token",
                    "account_id": "account-123",
                },
                "last_refresh": "2020-01-01T00:00:00.000Z",
            }
        )
    )
    requests: list[dict[str, Any]] = []

    class OAuthHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            content_length = int(self.headers["Content-Length"])
            requests.append(json.loads(self.rfile.read(content_length)))
            response = json.dumps(
                {
                    "access_token": "new-access-token",
                    "refresh_token": "rotated-refresh-token",
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), OAuthHandler)
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    script = """
import { readCodexAuth } from './dist/auth.js';
const [authPath, refreshEndpoint] = process.argv.slice(1);
const authResults = await Promise.all(
  Array.from({ length: 8 }, () => readCodexAuth(authPath, { refreshEndpoint })),
);
console.log(JSON.stringify(authResults));
"""

    try:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True, capture_output=True)
        completed = subprocess.run(
            [
                "node",
                "--input-type=module",
                "--eval",
                script,
                str(auth_path),
                f"http://127.0.0.1:{server.server_port}/oauth/token",
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)

    assert completed.returncode == 0, completed.stderr
    auth_results = json.loads(completed.stdout)
    assert auth_results == [
        {"accessToken": "new-access-token", "accountId": "account-123"}
    ] * 8
    assert requests == [
        {
            "client_id": CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": "old-refresh-token",
        }
    ]
    persisted = json.loads(auth_path.read_text())
    assert persisted["tokens"] == {
        "access_token": "new-access-token",
        "refresh_token": "rotated-refresh-token",
        "id_token": "preserved-id-token",
        "account_id": "account-123",
    }
    assert persisted["last_refresh"] != "2020-01-01T00:00:00.000Z"
