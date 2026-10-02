"""Burtson Training Studio API (see CONTRACT.md in the training docs).

Public routes (``/api/*``) take an AuthApi JWT: admin for everything, the narrow ``training``
role for dataset upload/list. Internal routes (``/internal/*``) are never routed by the Ingress
or Anton's proxy: Anton's GPU intent poll (in-cluster, read-mostly) and the worker callbacks
(per-run token).
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse

from . import auth, catalog, datasets as ds, ollama, storage, trainsets as ts
from .runs import RunError, Runs, Window, public as public_run, utcnow

logger = logging.getLogger("training.api")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

MAX_DATASET_BYTES = int(os.getenv("MAX_DATASET_MIB", "2048")) * 1024 * 1024
VRAM_GB = float(os.getenv("GPU_VRAM_GB", "32"))
TICK_SECONDS = float(os.getenv("DISPATCH_TICK_SECONDS", "15"))


class State:
    store: Any = None
    db: Any = None
    runs: Runs | None = None
    registrar: ollama.Registrar | None = None
    task: asyncio.Task | None = None


state = State()


def configure(store, db, launcher, *, registrar=None, window: Window | None = None, clock=utcnow) -> None:
    """Wire dependencies (production at startup, fakes in tests)."""
    state.store, state.db = store, db
    state.runs = Runs(db, launcher, vram_gb=VRAM_GB, window=window, clock=clock)
    state.registrar = registrar
    db.examples.create_index([("datasetId", 1), ("offset", 1)])
    db.examples.create_index([("datasetId", 1), ("source", 1), ("status", 1)])
    db.runs.create_index([("status", 1), ("createdAt", 1)])


async def dispatcher() -> None:
    while True:
        try:
            await asyncio.to_thread(state.runs.tick)
            if state.registrar:
                await asyncio.to_thread(ollama.pending_pass, state.db, state.registrar, utcnow)
        except Exception:  # keep the loop alive; the error is in the log
            logger.exception("dispatcher tick failed")
        await asyncio.sleep(TICK_SECONDS)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if state.db is None and os.getenv("MONGO_URI"):
        from pymongo import MongoClient

        from .jobs import K8sLauncher

        client = MongoClient(os.environ["MONGO_URI"], w="majority", serverSelectionTimeoutMS=5000, appname="training-api")
        store = storage.S3Store()
        try:
            store.ensure_bucket()
        except Exception:
            logger.exception("could not ensure the training bucket")
        db = client[os.getenv("MONGO_DB", "burtson_training")]
        configure(store, db, K8sLauncher(), registrar=ollama.Registrar(store),
                  window=Window(os.getenv("NIGHT_START", "22:00"), os.getenv("NIGHT_END", "07:00"),
                                os.getenv("NIGHT_TZ", "America/Chicago")))
        state.task = asyncio.create_task(dispatcher())
    yield
    if state.task:
        state.task.cancel()


app = FastAPI(title="Burtson Training Studio", lifespan=lifespan)


def ready() -> Runs:
    if state.runs is None:
        raise HTTPException(503, "training-api is not configured (MONGO_URI)")
    return state.runs


@app.exception_handler(ds.DatasetError)
@app.exception_handler(ts.TrainsetError)
@app.exception_handler(RunError)
async def domain_error(_request: Request, exc):
    return JSONResponse(status_code=exc.status, content={"detail": str(exc)})


@app.get("/health/live")
async def live() -> dict:
    return {"ok": True}


@app.get("/health/ready")
async def health_ready() -> dict:
    ready()
    return {"ok": True}


# --- catalog -----------------------------------------------------------------------------------
@app.get("/api/catalog")
async def get_catalog(_: auth.Caller = Depends(auth.admin)) -> dict:
    return {"baseModels": catalog.public_catalog(VRAM_GB), "exports": list(catalog.EXPORTS),
            "gpuVramGb": VRAM_GB, "hyperBounds": catalog.HYPER_BOUNDS,
            "window": {"start": ready().window.start, "end": ready().window.end, "timezone": ready().window.timezone}}


# --- datasets ----------------------------------------------------------------------------------
@app.post("/api/datasets", status_code=201)
async def upload_dataset(manifest: UploadFile = File(...), examples: UploadFile = File(...),
                         scrubReport: UploadFile | None = File(default=None),
                         caller: auth.Caller = Depends(auth.uploader)) -> dict:
    ready()
    manifest_raw = await manifest.read()
    report_raw = await scrubReport.read() if scrubReport else None
    doc = await asyncio.to_thread(ds.ingest, state.store, state.db, owner=caller.owner, manifest_raw=manifest_raw,
                                  examples_gz=examples.file, scrub_report_raw=report_raw, max_bytes=MAX_DATASET_BYTES)
    return {"id": doc["_id"], "stats": doc["stats"], "rejected": doc["rejectedCount"],
            "rejectedSample": doc["rejected"][:5]}


@app.get("/api/datasets")
async def list_datasets(_: auth.Caller = Depends(auth.uploader)) -> dict:
    ready()
    docs = state.db.datasets.find({}, {"manifest": 0, "rejected": 0}).sort("createdAt", -1)
    return {"items": [ds.public_dataset(d) for d in docs]}


@app.get("/api/datasets/{dataset_id}")
async def get_dataset(dataset_id: str, _: auth.Caller = Depends(auth.admin)) -> dict:
    ready()
    doc = state.db.datasets.find_one({"_id": dataset_id})
    if not doc:
        raise HTTPException(404, "unknown dataset")
    out = ds.public_dataset(doc)
    try:
        import json
        out["scrubReport"] = json.loads(state.store.get_bytes(f"{storage.DATASETS}/{dataset_id}/scrub-report.json"))
    except Exception:
        out["scrubReport"] = None
    return out


@app.get("/api/datasets/{dataset_id}/examples")
async def list_examples(dataset_id: str, offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100),
                        source: str | None = None, status: str | None = None, q: str | None = None,
                        full: bool | None = None, _: auth.Caller = Depends(auth.admin)) -> dict:
    ready()
    if not state.db.datasets.find_one({"_id": dataset_id}, {"_id": 1}):
        raise HTTPException(404, "unknown dataset")
    return await asyncio.to_thread(ds.page, state.store, state.db, dataset_id, offset=offset, limit=limit,
                                   source=source, status=status, q=q, full=limit <= 25 if full is None else full)


@app.patch("/api/datasets/{dataset_id}/examples/{ex_id}")
async def patch_example(dataset_id: str, ex_id: str, body: dict, _: auth.Caller = Depends(auth.admin)) -> dict:
    ready()
    update: dict[str, Any] = {}
    if "excluded" in body:
        update["excluded"] = bool(body["excluded"])
    if "note" in body:
        update["note"] = (str(body["note"])[:500] or None) if body["note"] is not None else None
    if not update:
        raise HTTPException(400, "nothing to change (excluded, note)")
    res = state.db.examples.update_one({"_id": f"{dataset_id}:{ex_id}"}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(404, "unknown example")
    stats = await asyncio.to_thread(ds.refresh_stats, state.db, dataset_id)
    row = state.db.examples.find_one({"_id": f"{dataset_id}:{ex_id}"}, {"_id": 0, "excluded": 1, "note": 1, "flags": 1})
    return {"id": ex_id, **row, "stats": stats}


@app.delete("/api/datasets/{dataset_id}")
async def delete_dataset(dataset_id: str, force: bool = False, _: auth.Caller = Depends(auth.admin)) -> dict:
    ready()
    if not state.db.datasets.find_one({"_id": dataset_id}, {"_id": 1}):
        raise HTTPException(404, "unknown dataset")
    used = state.db.trainsets.count_documents({"datasetIds": dataset_id})
    if used and not force:
        raise HTTPException(409, f"used by {used} train set(s); frozen train sets keep their copy — pass force=true")
    removed = await asyncio.to_thread(state.store.delete_prefix, f"{storage.DATASETS}/{dataset_id}/")
    state.db.examples.delete_many({"datasetId": dataset_id})
    state.db.datasets.delete_one({"_id": dataset_id})
    return {"deleted": dataset_id, "objects": removed}


# --- train sets --------------------------------------------------------------------------------
@app.post("/api/trainsets", status_code=201)
async def create_trainset(body: dict, caller: auth.Caller = Depends(auth.admin)) -> dict:
    ready()
    doc = await asyncio.to_thread(ts.create, state.store, state.db, owner=caller.owner, name=str(body.get("name") or ""),
                                  dataset_ids=list(body.get("datasetIds") or []), filters=dict(body.get("filters") or {}),
                                  eval_fraction=float(body.get("evalFraction", 0.05)))
    return ts.public(doc)


@app.get("/api/trainsets")
async def list_trainsets(_: auth.Caller = Depends(auth.admin)) -> dict:
    ready()
    return {"items": [ts.public(d) for d in state.db.trainsets.find().sort("createdAt", -1)]}


@app.get("/api/trainsets/{trainset_id}")
async def get_trainset(trainset_id: str, _: auth.Caller = Depends(auth.admin)) -> dict:
    ready()
    doc = state.db.trainsets.find_one({"_id": trainset_id})
    if not doc:
        raise HTTPException(404, "unknown train set")
    return ts.public(doc)


# --- runs --------------------------------------------------------------------------------------
@app.post("/api/runs", status_code=201)
async def create_run(body: dict, caller: auth.Caller = Depends(auth.admin)) -> dict:
    runs = ready()
    run = runs.create(owner=caller.owner, body=body)
    await asyncio.to_thread(runs.tick)
    return public_run(runs.get(run["_id"]))


@app.get("/api/runs")
async def list_runs(_: auth.Caller = Depends(auth.admin)) -> dict:
    ready()
    docs = state.db.runs.find({}, {"points": 0, "logTail": 0}).sort("createdAt", -1).limit(200)
    return {"items": [public_run(d) for d in docs]}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str, _: auth.Caller = Depends(auth.admin)) -> dict:
    runs = ready()
    run = runs.get(run_id)
    logs = await asyncio.to_thread(runs.logs, run)
    return public_run(run, logs=logs)


@app.post("/api/runs/{run_id}/cancel")
async def cancel_run(run_id: str, _: auth.Caller = Depends(auth.admin)) -> dict:
    runs = ready()
    return public_run(await asyncio.to_thread(runs.cancel, run_id))


@app.post("/api/runs/{run_id}/resume")
async def resume_run(run_id: str, _: auth.Caller = Depends(auth.admin)) -> dict:
    runs = ready()
    runs.resume(run_id)
    await asyncio.to_thread(runs.tick)
    return public_run(runs.get(run_id))


# --- models ------------------------------------------------------------------------------------
@app.get("/api/models")
async def list_models(_: auth.Caller = Depends(auth.admin)) -> dict:
    ready()
    docs = state.db.runs.find({"status": "completed"}, {"points": 0, "logTail": 0}).sort("finishedAt", -1)
    items = []
    for d in docs:
        items.append({"runId": d["_id"], "name": d.get("name"), "baseModel": d["baseModel"], "method": d["method"],
                      "finishedAt": public_run(d).get("finishedAt"), "artifacts": d.get("artifacts") or {},
                      "eval": d.get("eval"), "ollama": d.get("ollama"), "ollamaModel": ollama.model_name(d["_id"])})
    return {"items": items}


@app.post("/api/models/{run_id}/ollama", status_code=202)
async def reregister(run_id: str, quant: str = Query("q4_k_m", pattern="^(q4_k_m|q8_0)$"),
                     _: auth.Caller = Depends(auth.admin)) -> dict:
    runs = ready()
    run = runs.get(run_id)
    if run["status"] != "completed":
        raise HTTPException(409, "only completed runs can be registered")
    if f"gguf-{quant}" not in (run.get("artifacts") or {}):
        raise HTTPException(400, f"run has no gguf-{quant} export")
    state.db.runs.update_one({"_id": run_id}, {"$set": {"ollama": {"status": "pending", "quant": quant}}})
    return {"runId": run_id, "ollama": {"status": "pending", "quant": quant}, "model": ollama.model_name(run_id)}


# --- internal: Anton GPU intent ----------------------------------------------------------------
@app.get("/internal/gpu-intent")
async def gpu_intent(held: bool = False, phase: str | None = None) -> dict:
    runs = ready()
    return await asyncio.to_thread(runs.intent, held=held, phase=phase)


# --- internal: worker callbacks ----------------------------------------------------------------
def worker_run(run_id: str, token: str | None) -> dict:
    return ready().check_token(run_id, token)


@app.get("/internal/runs/{run_id}/spec")
async def run_spec(run_id: str, x_run_token: str | None = Header(default=None)) -> dict:
    run = worker_run(run_id, x_run_token)
    spec = ready().spec(run, os.getenv("MINIO_BUCKET", "training"))
    # The worker evaluates through a private Ollama with exactly what the cluster Ollama will get.
    spec["ollama"] = {k: v for k, v in ollama.create_body(run, "0" * 64, "q8_0").items() if k in ("template", "parameters")}
    return spec


@app.post("/internal/runs/{run_id}/progress")
async def run_progress(run_id: str, body: dict, x_run_token: str | None = Header(default=None)) -> dict:
    run = worker_run(run_id, x_run_token)
    updated = ready().progress(run, body)
    return {"status": updated["status"]}


@app.post("/internal/runs/{run_id}/complete")
async def run_complete(run_id: str, body: dict, x_run_token: str | None = Header(default=None)) -> dict:
    run = worker_run(run_id, x_run_token)
    return {"status": ready().complete(run, body)["status"]}


@app.post("/internal/runs/{run_id}/fail")
async def run_fail(run_id: str, body: dict, x_run_token: str | None = Header(default=None)) -> dict:
    run = worker_run(run_id, x_run_token)
    return {"status": ready().fail(run, body)["status"]}
