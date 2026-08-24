"""
when a Bash function tool is offered -> the assistant must return a real tool_call       ✓
when that call requests `echo hello` -> the test executes only that safe command         ✓
when the tool result is returned -> the assistant must acknowledge the observed output   ✓

Fix: preserve OpenAI function tools and tool-call messages across the Codex Responses API.
Test: tests/test_tool_access.py::test_bash_tool_access ✅
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pytest


ROOT = Path(__file__).resolve().parents[1]
QUESTION = "hello, please echo hello in bash so that I can know whether the tools work correctly"
BASH_TOOL = {
    "type": "function",
    "function": {
        "name": "Bash",
        "description": "Run a safe shell command and return its output.",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
            "additionalProperties": False,
        },
    },
}


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _post_json(url: str, body: dict[str, Any]) -> dict[str, Any]:
    request = Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer dummy"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=120) as response:
            return json.load(response)
    except HTTPError as error:
        pytest.fail(f"proxy returned HTTP {error.code}: {error.read().decode()}")


def _get_json(url: str) -> dict[str, Any]:
    with urlopen(url, timeout=120) as response:
        return json.load(response)


@pytest.fixture(scope="module")
def proxy() -> tuple[str, str]:
    auth_path = Path(os.environ.get("CODEX_AUTH_PATH", Path.home() / ".codex" / "auth.json"))
    if not auth_path.exists():
        pytest.skip(f"live Codex credentials are unavailable: {auth_path}")

    subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
    port = _free_port()
    process = subprocess.Popen(
        ["proxychains4", "node", "dist/cli.js", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    health_url = f"http://127.0.0.1:{port}/health"
    try:
        for _ in range(100):
            if process.poll() is not None:
                output = process.stdout.read() if process.stdout else ""
                pytest.fail(f"proxy exited during startup:\n{output}")
            try:
                with urlopen(health_url, timeout=1) as response:
                    if response.status == 200:
                        break
            except URLError:
                time.sleep(0.05)
        else:
            pytest.fail("proxy did not become healthy")
        proxy_url = f"http://127.0.0.1:{port}"
        models = _get_json(f"{proxy_url}/v1/models").get("data", [])
        requested_model = os.environ.get("CODEX_TEST_MODEL")
        model = requested_model or next(
            (item.get("id") for item in models if isinstance(item.get("id"), str)), None
        )
        if not model:
            pytest.skip("the Codex account returned no available models")
        yield proxy_url, model
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def test_bash_tool_access(proxy: tuple[str, str]) -> None:
    proxy_url, model = proxy
    messages: list[dict[str, Any]] = [{"role": "user", "content": QUESTION}]
    first = _post_json(
        f"{proxy_url}/v1/chat/completions",
        {"model": model, "messages": messages, "tools": [BASH_TOOL], "tool_choice": "auto"},
    )
    message = first["choices"][0]["message"]
    tool_calls = message.get("tool_calls") or []
    tool_access = bool(tool_calls)
    print(f"tool_access: {str(tool_access).lower()}")
    assert tool_access is True, f"tool_access: {tool_access}; response={first}"

    call = tool_calls[0]
    assert call["function"]["name"] == "Bash"
    arguments = json.loads(call["function"]["arguments"])
    assert arguments["command"].strip() == "echo hello"
    completed = subprocess.run(
        ["bash", "-c", "echo hello"], capture_output=True, text=True, check=True
    )
    assert completed.stdout == "hello\n"

    messages.extend(
        [
            message,
            {"role": "tool", "tool_call_id": call["id"], "content": completed.stdout},
        ]
    )
    second = _post_json(
        f"{proxy_url}/v1/chat/completions",
        {"model": model, "messages": messages, "tools": [BASH_TOOL], "tool_choice": "auto"},
    )
    final_text = second["choices"][0]["message"].get("content") or ""
    assert "hello" in final_text.lower()
