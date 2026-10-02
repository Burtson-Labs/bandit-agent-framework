"""training-api callbacks and MinIO access for the worker."""
from __future__ import annotations

import hashlib
import os
import time

import httpx


class Cancelled(Exception):
    """training-api answered 409: the run was cancelled (or otherwise finished) elsewhere."""


class Api:
    def __init__(self, base_url: str, run_id: str, token: str, client: httpx.Client | None = None):
        self.base = base_url.rstrip("/")
        self.run_id = run_id
        self.client = client or httpx.Client(timeout=30, headers={"X-Run-Token": token})

    def _url(self, path: str) -> str:
        return f"{self.base}/internal/runs/{self.run_id}/{path}"

    def spec(self) -> dict:
        res = self.client.get(self._url("spec"))
        res.raise_for_status()
        return res.json()

    def post(self, path: str, body: dict, *, retries: int = 5) -> dict:
        for attempt in range(retries):
            try:
                res = self.client.post(self._url(path), json=body)
                if res.status_code == 409:
                    raise Cancelled(res.text)
                res.raise_for_status()
                return res.json()
            except Cancelled:
                raise
            except httpx.HTTPError:
                if attempt == retries - 1:
                    raise
                time.sleep(2 * (attempt + 1))
        return {}

    def progress(self, **fields) -> None:
        self.post("progress", {k: v for k, v in fields.items() if v is not None})

    def complete(self, artifacts: dict, eval_result: dict | None) -> None:
        self.post("complete", {"artifacts": artifacts, "eval": eval_result}, retries=20)

    def fail(self, error: str) -> None:
        try:
            self.post("fail", {"error": error[:2000]}, retries=3)
        except Exception:
            pass


class Bucket:
    def __init__(self, bucket: str | None = None):
        import boto3
        from botocore.client import Config

        self.bucket = bucket or os.getenv("MINIO_BUCKET", "training")
        self.s3 = boto3.client("s3", endpoint_url=os.environ["MINIO_ENDPOINT"],
                               aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
                               aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
                               config=Config(signature_version="s3v4", request_checksum_calculation="when_required"),
                               region_name=os.getenv("MINIO_REGION", "us-east-1"))

    def download(self, key: str, path: str) -> None:
        self.s3.download_file(self.bucket, key, path)

    def upload(self, path: str, key: str, content_type: str = "application/octet-stream") -> dict:
        self.s3.upload_file(path, self.bucket, key, ExtraArgs={"ContentType": content_type})
        return {"key": key, "size": os.path.getsize(path), "sha256": sha256_file(path)}

    def upload_dir(self, directory: str, prefix: str) -> dict:
        files = []
        for root, _dirs, names in os.walk(directory):
            for name in names:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, directory)
                self.s3.upload_file(full, self.bucket, f"{prefix}/{rel}")
                files.append(rel)
        return {"prefix": prefix, "files": sorted(files)}


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
