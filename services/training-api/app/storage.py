"""Object storage (MinIO bucket ``training``). ``MemoryStore`` stands in for tests."""
from __future__ import annotations

import base64
import hashlib
import os
from typing import BinaryIO, Iterator, Protocol

DATASETS = "datasets"
TRAINSETS = "trainsets"
RUNS = "runs"


class Store(Protocol):
    def put_bytes(self, key: str, body: bytes, content_type: str = "application/octet-stream") -> None: ...
    def put_file(self, key: str, path: str, content_type: str = "application/octet-stream") -> None: ...
    def get_bytes(self, key: str) -> bytes: ...
    def get_range(self, key: str, start: int, length: int) -> bytes: ...
    def iter_lines(self, key: str) -> Iterator[bytes]: ...
    def open_stream(self, key: str) -> BinaryIO: ...
    def size(self, key: str) -> int | None: ...
    def delete_prefix(self, prefix: str) -> int: ...


class S3Store:
    def __init__(self, bucket: str | None = None):
        import boto3
        from botocore.client import Config

        self.bucket = bucket or os.getenv("MINIO_BUCKET", "training")
        self.client = boto3.client(
            "s3",
            endpoint_url=os.environ["MINIO_ENDPOINT"],
            aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
            aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
            config=Config(signature_version="s3v4", request_checksum_calculation="when_required"),
            region_name=os.getenv("MINIO_REGION", "us-east-1"),
        )
        # The deployed MinIO refuses DeleteObjects without Content-MD5 (same as image-api).
        self.client.meta.events.register_first("request-created.s3.DeleteObjects", _content_md5)

    def ensure_bucket(self) -> None:
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except Exception:
            self.client.create_bucket(Bucket=self.bucket)

    def put_bytes(self, key, body, content_type="application/octet-stream"):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)

    def put_file(self, key, path, content_type="application/octet-stream"):
        self.client.upload_file(path, self.bucket, key, ExtraArgs={"ContentType": content_type})

    def get_bytes(self, key):
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def get_range(self, key, start, length):
        res = self.client.get_object(Bucket=self.bucket, Key=key, Range=f"bytes={start}-{start + length - 1}")
        return res["Body"].read()

    def iter_lines(self, key):
        body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"]
        yield from body.iter_lines(keepends=False)

    def open_stream(self, key):
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"]

    def size(self, key):
        try:
            return int(self.client.head_object(Bucket=self.bucket, Key=key)["ContentLength"])
        except Exception:
            return None

    def delete_prefix(self, prefix):
        removed = 0
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if keys:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": keys, "Quiet": True})
                removed += len(keys)
        return removed


def _content_md5(request, **_kwargs):
    body = request.body.encode() if isinstance(request.body, str) else request.body
    if body is not None:
        request.headers["Content-MD5"] = base64.b64encode(hashlib.md5(body, usedforsecurity=False).digest()).decode()


class MemoryStore:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def put_bytes(self, key, body, content_type="application/octet-stream"):
        self.objects[key] = bytes(body)

    def put_file(self, key, path, content_type="application/octet-stream"):
        with open(path, "rb") as handle:
            self.objects[key] = handle.read()

    def get_bytes(self, key):
        if key not in self.objects:
            raise KeyError(key)
        return self.objects[key]

    def get_range(self, key, start, length):
        return self.get_bytes(key)[start:start + length]

    def iter_lines(self, key):
        yield from self.get_bytes(key).splitlines()

    def open_stream(self, key):
        import io
        return io.BytesIO(self.get_bytes(key))

    def size(self, key):
        return len(self.objects[key]) if key in self.objects else None

    def delete_prefix(self, prefix):
        doomed = [k for k in self.objects if k.startswith(prefix)]
        for key in doomed:
            del self.objects[key]
        return len(doomed)
