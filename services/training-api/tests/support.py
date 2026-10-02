"""Shared fakes: canonical examples, a JWT minter, a fake Job launcher."""
import gzip
import io
import json
import time

import jwt

from app import auth

SECRET = "test-only-training-secret-0123456789abcdef"
auth.settings.secret = SECRET


def token(roles=("admin",), sub="user-1", email="mark@example.com", audience="gateway-api", exp=3600):
    claims = {"sub": sub, "email": email, "roles": list(roles), "iss": "https://burtson.ai", "aud": [audience],
              "exp": int(time.time()) + exp}
    return jwt.encode(claims, SECRET, algorithm="HS256")


def bearer(**kw):
    return {"Authorization": f"Bearer {token(**kw)}"}


def example(i, *, status="completed", source="cli-session", tool_calls=1, hit_limit=False, text=None):
    messages = [{"role": "system", "content": "You are Bandit."},
                {"role": "user", "content": text or f"Fix the failing test number {i}"}]
    for n in range(tool_calls):
        messages.append({"role": "assistant", "content": "",
                         "tool_calls": [{"id": f"call_{n}", "type": "function",
                                         "function": {"name": "read_file", "arguments": json.dumps({"path": f"src/{n}.ts"})}}]})
        messages.append({"role": "tool", "tool_call_id": f"call_{n}", "name": "read_file", "content": "export const x = 1;"})
    messages.append({"role": "assistant", "content": "Done: the test passes now."})
    return {"id": f"ex_{i:04d}", "source": source, "sourceRef": f"session-{i}", "createdAt": "2026-09-01T00:00:00Z",
            "model": "bandit-logic-2", "status": status,
            "labels": {"hitLimit": hit_limit, "toolCalls": tool_calls, "toolErrors": 0},
            "tools": [{"type": "function", "function": {"name": "read_file", "description": "Read a file",
                                                         "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}],
            "messages": messages, "scrub": {"version": "scrub-v1", "redactions": {}, "dropped": False}}


def gz(lines):
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as handle:
        for line in lines:
            handle.write((line if isinstance(line, str) else json.dumps(line)).encode() + b"\n")
    return buf.getvalue()


class FakeLauncher:
    def __init__(self):
        self.launched, self.deleted, self.states = [], [], {}
        self.fail_launch = False

    def launch(self, run, token):
        if self.fail_launch:
            raise RuntimeError("forbidden: jobs.batch")
        name = f"train-{run['_id']}-a{run['attempt']}"
        self.launched.append((name, token))
        self.states[name] = "active"
        return name

    def delete(self, job_name):
        self.deleted.append(job_name)
        self.states[job_name] = "missing"

    def state(self, job_name):
        return self.states.get(job_name, "missing")

    def logs(self, job_name, lines):
        return [f"{job_name}: step 1"]
