import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional
import difflib


def _normalize_root(root_value: Optional[str]) -> str:
    root = root_value or os.getcwd()
    return os.path.abspath(root)


def _success(**kwargs):
    return {"status": "SUCCESS", **kwargs}


def _failed(error: str, **kwargs):
    payload = {"status": "FAILED", "error": error}
    payload.update(kwargs)
    return payload


def scan_project(params):
    root = _normalize_root(params.get("root"))
    max_depth = int(params.get("maxDepth", 5))
    max_files = int(params.get("maxFiles", 400))
    include_exts = [ext.lower() for ext in params.get("includeExtensions", [])]

    collected = []

    skip_dirs = {'.git', '.bandit', 'node_modules', 'vendor', '.next', '.turbo', 'dist', 'build', '.cache', '.vscode', '.idea', '.vsce', 'out', '__pycache__'}

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        rel_dir = os.path.relpath(dirpath, root)
        depth = 0 if rel_dir in (".", "") else rel_dir.count(os.sep) + 1
        if depth > max_depth:
            dirnames[:] = []
            continue

        for filename in filenames:
            rel_path = os.path.relpath(os.path.join(dirpath, filename), root).replace('\\', '/')
            if include_exts:
                lowered = filename.lower()
                if not any(lowered.endswith(ext) for ext in include_exts):
                    continue
            collected.append(rel_path)
            if len(collected) >= max_files:
                break
        if len(collected) >= max_files:
            break

    package_json = None
    scripts = {}
    package_path = Path(root) / "package.json"
    if package_path.exists():
        try:
            with package_path.open("r", encoding="utf-8") as handle:
                package_json = json.load(handle)
                scripts = package_json.get("scripts", {}) or {}
        except Exception as exc:  # pragma: no cover - defensive
            return _failed(f"Failed to parse package.json: {exc}")

    return _success(data={
        "root": root,
        "files": collected,
        "packageJson": package_json,
        "scripts": scripts
    })


def read_file(params):
    root = _normalize_root(params.get("root"))
    relative_path = params.get("path")
    encoding = params.get("encoding", "utf-8")

    if not relative_path:
        return _failed('Path is required for readFile action.')

    absolute_path = os.path.abspath(os.path.join(root, relative_path))
    if not absolute_path.startswith(root):
        return _failed('Attempt to read outside project root.')

    if not os.path.exists(absolute_path):
        return _failed(f'File not found: {relative_path}')

    try:
        with open(absolute_path, 'r', encoding=encoding) as handle:
            content = handle.read()
        return _success(data={
            "path": relative_path,
            "content": content
        })
    except Exception as exc:  # pragma: no cover - defensive
        return _failed(f'Failed to read {relative_path}: {exc}')


def write_file(params):
    root = _normalize_root(params.get("root"))
    relative_path = params.get("path")
    content = params.get("content")
    encoding = params.get("encoding", "utf-8")

    if not relative_path:
        return _failed('Path is required for writeFile action.')
    if content is None:
        return _failed('Content is required for writeFile action.')

    absolute_path = os.path.abspath(os.path.join(root, relative_path))
    if not absolute_path.startswith(root):
        return _failed('Attempt to write outside project root.')

    try:
        os.makedirs(os.path.dirname(absolute_path), exist_ok=True)
        with open(absolute_path, 'w', encoding=encoding) as handle:
            handle.write(content)
        bytes_written = len(content.encode(encoding))
        return _success(data={
            "path": relative_path,
            "bytesWritten": bytes_written
        })
    except Exception as exc:  # pragma: no cover - defensive
        return _failed(f'Failed to write {relative_path}: {exc}')


def run_command(params):
    command = params.get("command")
    if not command:
        return _failed('Command is required for runCommand action.')

    cwd = params.get("cwd") or _normalize_root(params.get("root"))

    try:
        completed = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True
        )
        status = 'SUCCESS' if completed.returncode == 0 else 'FAILED'
        return {
            "status": status,
            "output": completed.stdout,
            "error": completed.stderr or None,
            "code": completed.returncode
        }
    except Exception as exc:  # pragma: no cover - defensive
        return _failed(f'Command failed: {exc}')


def diff_text(params):
    before = params.get('before', '') or ''
    after = params.get('after', '') or ''
    from_file = params.get('fromFile') or 'before'
    to_file = params.get('toFile') or 'after'

    before_lines = before.splitlines()
    after_lines = after.splitlines()
    diff_lines = list(difflib.unified_diff(
        before_lines,
        after_lines,
        fromfile=from_file,
        tofile=to_file,
        lineterm=''
    ))
    diff_text_value = '\n'.join(diff_lines)
    return _success(data={"diff": diff_text_value})


def main():
    payload = sys.stdin.read()
    if not payload:
        print(json.dumps(_failed('No payload provided.')))
        return

    data = json.loads(payload)
    action = data.get('action')
    params = data.get('payload', {})

    if action == 'scanProject':
        print(json.dumps(scan_project(params)))
        return

    if action == 'readFile':
        print(json.dumps(read_file(params)))
        return

    if action == 'writeFile':
        print(json.dumps(write_file(params)))
        return

    if action == 'runCommand':
        print(json.dumps(run_command(params)))
        return

    if action == 'diffText':
        print(json.dumps(diff_text(params)))
        return

    print(json.dumps(_failed(f'Unknown action: {action}')))


if __name__ == '__main__':
    main()
