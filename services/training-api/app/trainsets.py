"""Frozen train sets: datasets + filters + split, materialised once as train/eval JSONL.

The split is deterministic (sha256 of the example id), so re-freezing the same selection gives
the same eval set and runs stay comparable. Exclusions made after freezing don't change a
train set; freeze a new one.
"""
from __future__ import annotations

import hashlib
import secrets
from typing import Any

from . import datasets as ds
from . import storage

SOURCES = {"cli-session", "stealth-web", "banditbench", "mongo-stealth"}


class TrainsetError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def eval_bucket(ex_id: str) -> float:
    return int(hashlib.sha256(ex_id.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def selection_query(dataset_id: str, filters: dict) -> dict:
    query: dict[str, Any] = {"datasetId": dataset_id, "excluded": False}
    if filters.get("statuses"):
        query["status"] = {"$in": list(filters["statuses"])}
    if filters.get("sources"):
        query["source"] = {"$in": list(filters["sources"])}
    if filters.get("minToolCalls"):
        query["toolCalls"] = {"$gte": int(filters["minToolCalls"])}
    if filters.get("maxTokens"):
        query["tokens"] = {"$lte": int(filters["maxTokens"])}
    if filters.get("excludeHitLimit"):
        query["hitLimit"] = False
    return query


def create(store: storage.Store, db, *, owner: str, name: str, dataset_ids: list[str], filters: dict,
           eval_fraction: float) -> dict:
    if not dataset_ids:
        raise TrainsetError(400, "datasetIds is required")
    if not 0 <= eval_fraction <= 0.5:
        raise TrainsetError(400, "evalFraction must be between 0 and 0.5")
    missing = [d for d in dataset_ids if not db.datasets.find_one({"_id": d}, {"_id": 1})]
    if missing:
        raise TrainsetError(404, f"unknown dataset(s): {', '.join(missing)}")
    trainset_id = "ts_" + ds.now().strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(3)
    train, evals = [], []
    tokens = {"train": 0, "eval": 0}
    for dataset_id in dict.fromkeys(dataset_ids):
        rows = list(db.examples.find(selection_query(dataset_id, filters),
                                     {"offset": 1, "exId": 1, "tokens": 1}))
        wanted = {row["offset"]: row for row in rows}
        for row, line in ds.iter_selected(store, dataset_id, wanted):
            target = "eval" if eval_bucket(row["exId"]) < eval_fraction else "train"
            (evals if target == "eval" else train).append(line)
            tokens[target] += int(row.get("tokens") or 0)
    if not train:
        raise TrainsetError(400, "the filters leave no training examples")
    base = f"{storage.TRAINSETS}/{trainset_id}"
    store.put_bytes(f"{base}/train.jsonl", ("\n".join(train) + "\n").encode(), "application/x-ndjson")
    store.put_bytes(f"{base}/eval.jsonl", ("\n".join(evals) + "\n").encode() if evals else b"", "application/x-ndjson")
    doc = {
        "_id": trainset_id, "name": (name or trainset_id)[:120], "owner": owner, "createdAt": ds.now(),
        "datasetIds": list(dict.fromkeys(dataset_ids)), "filters": filters, "evalFraction": eval_fraction,
        "counts": {"train": len(train), "eval": len(evals), "examples": len(train) + len(evals)},
        "tokens": tokens, "keys": {"train": f"{base}/train.jsonl", "eval": f"{base}/eval.jsonl"},
    }
    db.trainsets.insert_one(doc)
    return doc


def public(doc: dict) -> dict:
    return ds.public_dataset(doc)
