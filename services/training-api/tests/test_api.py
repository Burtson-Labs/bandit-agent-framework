"""Training Studio API end to end with fakes: datasets → train sets → runs → GPU handshake →
worker callbacks → Ollama registration. Mongo is mongomock, storage is in memory, the clock is
injected, the Job launcher and Ollama are fakes."""
import gzip
import json
import unittest
from datetime import UTC, datetime, timedelta

import httpx
import mongomock
from fastapi.testclient import TestClient

from app import datasets as ds, jobs, main, ollama, storage
from app.runs import Window
from tests.support import FakeLauncher, bearer, example, gz

NOON_CHICAGO = datetime(2026, 10, 2, 17, 0, tzinfo=UTC)     # Fri 12:00 CDT: window closed
NIGHT_CHICAGO = datetime(2026, 10, 3, 4, 0, tzinfo=UTC)     # Fri 23:00 CDT: window open


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


class Base(unittest.TestCase):
    def setUp(self):
        self.store = storage.MemoryStore()
        self.db = mongomock.MongoClient()["burtson_training"]
        self.launcher = FakeLauncher()
        self.clock = Clock(NOON_CHICAGO)
        main.configure(self.store, self.db, self.launcher, window=Window(), clock=self.clock)
        self.client = TestClient(main.app)
        self.admin = bearer()

    def upload(self, examples, *, headers=None, manifest=None, report=None, snake=False):
        files = {"manifest": ("manifest.json", json.dumps(manifest or {"name": "cli sessions", "scrubVersion": "scrub-v1"})),
                 "examples": ("examples.jsonl.gz", gz(examples), "application/gzip")}
        if report is not None:
            files["scrub_report" if snake else "scrubReport"] = ("scrub-report.json", json.dumps(report))
        return self.client.post("/api/datasets", files=files, headers=headers or self.admin)

    def dataset(self, n=20, **kw):
        res = self.upload([example(i, **kw) for i in range(n)])
        self.assertEqual(res.status_code, 201, res.text)
        return res.json()["id"]

    def trainset(self, dataset_id, **body):
        res = self.client.post("/api/trainsets", json={"name": "ts", "datasetIds": [dataset_id], **body}, headers=self.admin)
        self.assertEqual(res.status_code, 201, res.text)
        return res.json()


class AuthTests(Base):
    def test_missing_wrong_and_expired_tokens(self):
        self.assertEqual(self.client.get("/api/runs").status_code, 401)
        self.assertEqual(self.client.get("/api/runs", headers={"Authorization": "Bearer nope"}).status_code, 401)
        self.assertEqual(self.client.get("/api/runs", headers=bearer(exp=-10)).status_code, 401)
        self.assertEqual(self.client.get("/api/runs", headers=bearer(audience="someone-else")).status_code, 401)

    def test_training_role_can_upload_and_list_only(self):
        collector = bearer(roles=("training",))
        self.assertEqual(self.upload([example(1)], headers=collector).status_code, 201)
        self.assertEqual(self.client.get("/api/datasets", headers=collector).status_code, 200)
        dataset_id = self.client.get("/api/datasets", headers=collector).json()["items"][0]["id"]
        self.assertEqual(self.client.get(f"/api/datasets/{dataset_id}/examples", headers=collector).status_code, 403)
        self.assertEqual(self.client.get("/api/runs", headers=collector).status_code, 403)
        self.assertEqual(self.client.post("/api/runs", json={}, headers=collector).status_code, 403)

    def test_other_roles_are_refused(self):
        self.assertEqual(self.upload([example(1)], headers=bearer(roles=("studio",))).status_code, 403)


class DatasetTests(Base):
    def test_upload_stats_and_storage_layout(self):
        examples = [example(i) for i in range(10)] + [example(10 + i, status="failed", source="stealth-web", tool_calls=3) for i in range(5)]
        res = self.upload(examples, report={"version": "scrub-v1", "totals": {"secret": 4}})
        self.assertEqual(res.status_code, 201, res.text)
        body = res.json()
        stats = body["stats"]
        self.assertEqual(stats["examples"], 15)
        self.assertEqual(stats["bySource"], {"cli-session": 10, "stealth-web": 5})
        self.assertEqual(stats["byStatus"], {"completed": 10, "failed": 5})
        self.assertEqual(stats["byTool"], {"read_file": 15})   # examples that use the tool
        self.assertGreater(stats["tokens"], 0)
        base = f"datasets/{body['id']}"
        for name in ("examples.jsonl.gz", "examples.jsonl", "manifest.json", "scrub-report.json"):
            self.assertIn(f"{base}/{name}", self.store.objects)
        detail = self.client.get(f"/api/datasets/{body['id']}", headers=self.admin).json()
        self.assertEqual(detail["scrubReport"]["totals"], {"secret": 4})
        self.assertEqual(detail["name"], "cli sessions")

    def test_the_cli_field_name_for_the_scrub_report_is_accepted(self):
        res = self.upload([example(i) for i in range(3)], report={"totals": {"email": 2}}, snake=True)
        self.assertEqual(res.status_code, 201, res.text)
        detail = self.client.get(f"/api/datasets/{res.json()['id']}", headers=self.admin).json()
        self.assertEqual(detail["scrubReport"]["totals"], {"email": 2})

    def test_unscrubbed_or_malformed_examples_are_rejected(self):
        bad = example(1)
        del bad["scrub"]
        res = self.upload([bad])
        self.assertEqual(res.status_code, 400)
        self.assertIn("not scrubbed", res.json()["detail"])
        no_assistant = example(2)
        no_assistant["messages"] = [m for m in no_assistant["messages"] if m["role"] != "assistant"]
        self.assertEqual(self.upload([no_assistant]).status_code, 400)
        orphan = example(3)
        orphan["messages"].insert(2, {"role": "tool", "tool_call_id": "nope", "content": "x"})
        self.assertIn("unknown tool_call_id", self.upload([orphan]).json()["detail"])
        dup = self.upload([example(4), example(4)])
        self.assertEqual((dup.status_code, dup.json()["rejected"]), (201, 1))     # a stray duplicate is skipped and reported
        self.assertIn("duplicate id", dup.json()["rejectedSample"][0])

    def test_a_few_bad_lines_are_skipped_and_reported(self):
        lines = [example(i) for i in range(30)] + ["{not json"]
        res = self.upload(lines)
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()["rejected"], 1)

    def test_not_gzip_is_400(self):
        files = {"manifest": ("m.json", "{}"), "examples": ("e.jsonl.gz", b"plain text", "application/gzip")}
        self.assertEqual(self.client.post("/api/datasets", files=files, headers=self.admin).status_code, 400)

    def test_secrets_that_slipped_through_are_flagged_and_excluded(self):
        leaky = example(1, text="here is my token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop please")
        res = self.upload([leaky, example(2), example(3)])
        stats = res.json()["stats"]
        self.assertEqual((stats["included"], stats["excluded"], stats["flagged"]), (2, 1, 1))
        page = self.client.get(f"/api/datasets/{res.json()['id']}/examples", headers=self.admin).json()
        flagged = [i for i in page["items"] if i["flags"]]
        self.assertEqual(flagged[0]["flags"], ["jwt"])
        self.assertTrue(flagged[0]["excluded"])

    def test_paging_filters_full_text_and_exclusions(self):
        dataset_id = self.dataset(30)
        self.upload([])  # ignored: nothing valid → 400, must not disturb anything
        page = self.client.get(f"/api/datasets/{dataset_id}/examples?offset=10&limit=5", headers=self.admin).json()
        self.assertEqual(page["total"], 30)
        self.assertEqual([i["id"] for i in page["items"]], [f"ex_{i:04d}" for i in range(10, 15)])
        self.assertEqual(page["items"][0]["example"]["id"], "ex_0010")       # full text round-trips by byte range
        search = self.client.get(f"/api/datasets/{dataset_id}/examples?q=number 7", headers=self.admin).json()
        self.assertEqual([i["id"] for i in search["items"]], ["ex_0007"])
        summary = self.client.get(f"/api/datasets/{dataset_id}/examples?limit=50", headers=self.admin).json()
        self.assertNotIn("example", summary["items"][0])                      # big pages are summaries
        res = self.client.patch(f"/api/datasets/{dataset_id}/examples/ex_0003", json={"excluded": True, "note": "noisy"},
                                headers=self.admin)
        self.assertEqual(res.json()["stats"]["excluded"], 1)
        self.assertEqual(self.client.patch(f"/api/datasets/{dataset_id}/examples/nope", json={"excluded": True},
                                           headers=self.admin).status_code, 404)

    def test_delete_refuses_while_a_trainset_uses_it(self):
        dataset_id = self.dataset(5)
        self.trainset(dataset_id)
        self.assertEqual(self.client.delete(f"/api/datasets/{dataset_id}", headers=self.admin).status_code, 409)
        res = self.client.delete(f"/api/datasets/{dataset_id}?force=true", headers=self.admin)
        self.assertEqual(res.status_code, 200)
        self.assertFalse([k for k in self.store.objects if k.startswith(f"datasets/{dataset_id}/")])
        self.assertEqual(self.db.examples.count_documents({"datasetId": dataset_id}), 0)


class TrainsetTests(Base):
    def test_filters_split_and_freeze(self):
        examples = ([example(i) for i in range(40)] + [example(100 + i, status="failed") for i in range(10)]
                    + [example(200 + i, hit_limit=True) for i in range(5)] + [example(300 + i, tool_calls=0) for i in range(5)])
        dataset_id = self.upload(examples).json()["id"]
        self.client.patch(f"/api/datasets/{dataset_id}/examples/ex_0001", json={"excluded": True}, headers=self.admin)
        ts = self.trainset(dataset_id, filters={"statuses": ["completed"], "excludeHitLimit": True, "minToolCalls": 1},
                           evalFraction=0.2)
        self.assertEqual(ts["counts"]["examples"], 39)                       # 40 completed − 1 excluded
        self.assertGreater(ts["counts"]["eval"], 0)
        train = self.store.get_bytes(ts["keys"]["train"]).decode().splitlines()
        ids = {json.loads(line)["id"] for line in train}
        self.assertNotIn("ex_0001", ids)
        self.assertFalse(ids & {f"ex_{100 + i:04d}" for i in range(10)})
        again = self.trainset(dataset_id, filters={"statuses": ["completed"], "excludeHitLimit": True, "minToolCalls": 1},
                              evalFraction=0.2)
        self.assertEqual(again["counts"], ts["counts"])                      # deterministic split
        # Exclusions after freezing don't change a frozen set.
        self.client.patch(f"/api/datasets/{dataset_id}/examples/ex_0002", json={"excluded": True}, headers=self.admin)
        self.assertEqual(self.store.get_bytes(ts["keys"]["train"]).decode().splitlines(), train)

    def test_empty_selection_and_unknown_dataset(self):
        dataset_id = self.dataset(3)
        res = self.client.post("/api/trainsets", json={"datasetIds": [dataset_id], "filters": {"statuses": ["failed"]}},
                               headers=self.admin)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.client.post("/api/trainsets", json={"datasetIds": ["ds_nope"]}, headers=self.admin).status_code, 404)


class RunTests(Base):
    def setUp(self):
        super().setUp()
        self.ts = self.trainset(self.dataset(10))

    def new_run(self, **body):
        res = self.client.post("/api/runs", json={"trainsetId": self.ts["id"], **body}, headers=self.admin)
        self.assertEqual(res.status_code, 201, res.text)
        return res.json()

    def anton(self, held=False, phase="idle"):
        return self.client.get(f"/internal/gpu-intent?held={str(held).lower()}&phase={phase}").json()

    def worker(self, run_id, path, body=None, token=None):
        token = token or self.launcher.launched[-1][1]
        return self.client.post(f"/internal/runs/{run_id}/{path}", json=body or {}, headers={"X-Run-Token": token})

    def test_validation_and_defaults(self):
        run = self.new_run(schedule="now")
        self.assertEqual((run["baseModel"], run["method"]), ("qwen3-8b", "lora"))
        self.assertEqual(run["hyper"]["rank"], 32)
        self.assertNotIn("tokenHash", run)
        for body, fragment in (({"baseModel": "llama3-70b"}, "baseModel"), ({"method": "full"}, "method"),
                               ({"baseModel": "qwen3-32b", "method": "lora"}, "VRAM"), ({"hyper": {"lr": 5}}, "hyper.lr"),
                               ({"schedule": "tomorrow"}, "schedule"), ({"exports": ["onnx"]}, "export")):
            res = self.client.post("/api/runs", json={"trainsetId": self.ts["id"], **body}, headers=self.admin)
            self.assertEqual(res.status_code, 400, body)
            self.assertIn(fragment, res.json()["detail"])
        self.assertEqual(self.client.post("/api/runs", json={"trainsetId": "ts_nope"}, headers=self.admin).status_code, 404)

    def test_full_lifecycle_now(self):
        run = self.new_run(schedule="now", name="first")
        self.assertEqual(run["status"], "waiting_for_gpu")
        self.assertTrue(self.anton()["wantGpu"])
        self.assertEqual(self.launcher.launched, [])                          # never before Anton holds the card
        intent = self.anton(held=True, phase="ready")
        self.assertTrue(intent["running"])
        job, token = self.launcher.launched[0]
        self.assertEqual(self.client.get(f"/api/runs/{run['id']}", headers=self.admin).json()["status"], "preparing")
        # Worker: spec, progress, completion.
        self.assertEqual(self.client.get(f"/internal/runs/{run['id']}/spec").status_code, 401)
        spec = self.client.get(f"/internal/runs/{run['id']}/spec", headers={"X-Run-Token": token}).json()
        self.assertEqual(spec["hf"], "Qwen/Qwen3-8B")
        self.assertEqual(spec["trainKeys"], self.ts["keys"])
        self.assertIn("<tool_response>", spec["ollama"]["template"])           # same template the cluster gets
        self.assertEqual(self.worker(run["id"], "progress", {"status": "training", "step": 10, "totalSteps": 100,
                                                            "loss": 1.25, "log": ["step 10"]}).json()["status"], "training")
        self.worker(run["id"], "progress", {"step": 20, "loss": 1.1, "evalLoss": 1.2})
        detail = self.client.get(f"/api/runs/{run['id']}", headers=self.admin).json()
        self.assertEqual([p["step"] for p in detail["lossCurve"]], [10, 20])
        self.assertEqual(detail["progress"]["totalSteps"], 100)
        self.assertEqual(detail["logs"], [f"{job}: step 1"])                  # live pod logs while running
        self.assertEqual(self.worker(run["id"], "progress", {}, token="wrong").status_code, 401)
        artifacts = {"gguf-q4_k_m": {"key": f"runs/{run['id']}/model.q4_k_m.gguf", "sha256": "a" * 64, "size": 3}}
        self.worker(run["id"], "complete", {"artifacts": artifacts, "eval": {"passRate": 0.8}})
        self.launcher.states[job] = "succeeded"
        self.assertEqual(self.anton(held=True, phase="ready"), {"wantGpu": False, "running": False, "runId": None,
                                                                "reason": "nothing due"})
        models = self.client.get("/api/models", headers=self.admin).json()["items"]
        self.assertEqual(models[0]["ollama"]["status"], "pending")
        self.assertEqual(models[0]["ollamaModel"], f"bandit-local:{run['id']}")

    def test_night_runs_wait_for_the_window_and_go_back_if_it_closes(self):
        run = self.new_run()                                                      # schedule defaults to night
        self.assertEqual(run["status"], "queued")
        self.assertFalse(self.anton()["wantGpu"])
        self.clock.now = NIGHT_CHICAGO
        self.assertTrue(self.anton()["wantGpu"])
        self.clock.now = NIGHT_CHICAGO + timedelta(hours=9)                   # 08:00, never got the card
        self.assertFalse(self.anton()["wantGpu"])
        self.assertEqual(self.client.get(f"/api/runs/{run['id']}", headers=self.admin).json()["status"], "queued")

    def test_a_running_run_is_never_preempted_by_the_window(self):
        self.clock.now = NIGHT_CHICAGO
        run = self.new_run()
        self.anton(held=True, phase="ready")
        self.clock.now = NIGHT_CHICAGO + timedelta(hours=10)
        intent = self.anton(held=True, phase="ready")
        self.assertTrue(intent["wantGpu"] and intent["running"])
        self.assertEqual(self.launcher.deleted, [])

    def test_stale_anton_state_does_not_launch(self):
        self.new_run(schedule="now")
        self.anton(held=True, phase="ready")
        self.assertEqual(len(self.launcher.launched), 1)
        # A second run queued later must not launch on a 10-minute-old "ready".
        self.launcher.states[self.launcher.launched[0][0]] = "failed"
        self.clock.now += timedelta(minutes=10)
        self.new_run(schedule="now")
        self.assertEqual(len(self.launcher.launched), 1)

    def test_one_run_at_a_time_fifo(self):
        first, second = self.new_run(schedule="now"), self.new_run(schedule="now")
        self.anton(held=True, phase="ready")
        self.assertEqual(self.client.get(f"/api/runs/{second['id']}", headers=self.admin).json()["status"], "queued")
        self.worker(first["id"], "complete", {"artifacts": {}})
        self.launcher.states[self.launcher.launched[0][0]] = "succeeded"
        self.anton(held=True, phase="ready")
        self.assertEqual(len(self.launcher.launched), 2)

    def test_dead_job_fails_the_run_with_logs_and_cancel_resume(self):
        run = self.new_run(schedule="now")
        self.anton(held=True, phase="ready")
        self.launcher.states[self.launcher.launched[0][0]] = "failed"
        self.anton(held=True, phase="ready")
        failed = self.client.get(f"/api/runs/{run['id']}", headers=self.admin).json()
        self.assertEqual(failed["status"], "failed")
        self.assertIn("worker job failed", failed["error"])
        resumed = self.client.post(f"/api/runs/{run['id']}/resume", headers=self.admin).json()
        # Anton still holds the card, so the resumed run starts at once as attempt 2.
        self.assertEqual((resumed["status"], resumed["resume"]), ("preparing", True))
        self.assertTrue(self.launcher.launched[-1][0].endswith("-a2"))       # new attempt, new job name
        cancelled = self.client.post(f"/api/runs/{run['id']}/cancel", headers=self.admin).json()
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(self.launcher.deleted, [self.launcher.launched[-1][0]])
        self.assertEqual(self.worker(run["id"], "progress", {"step": 1}).status_code, 409)   # worker learns to stop
        self.assertEqual(self.client.post(f"/api/runs/{run['id']}/cancel", headers=self.admin).status_code, 409)

    def test_launch_failure_fails_the_run_instead_of_wedging(self):
        self.launcher.fail_launch = True
        run = self.new_run(schedule="now")
        self.anton(held=True, phase="ready")
        detail = self.client.get(f"/api/runs/{run['id']}", headers=self.admin).json()
        self.assertEqual(detail["status"], "failed")
        self.assertIn("forbidden", detail["error"])

    def test_catalog(self):
        cat = self.client.get("/api/catalog", headers=self.admin).json()
        by_id = {m["id"]: m for m in cat["baseModels"]}
        self.assertTrue(by_id["qwen3-8b"]["default"])
        self.assertEqual(by_id["qwen3-32b"]["fits"], {"lora": False, "qlora": False})
        self.assertTrue(by_id["qwen3-0.6b"]["smoke"])


class JobManifestTests(unittest.TestCase):
    def test_gpu_job_shape(self):
        run = {"_id": "run_20261003_abc", "attempt": 2, "smoke": True}
        m = jobs.job_manifest(run, "tok", image="img:1", namespace="ai-training", api_url="http://api")
        spec = m["spec"]["template"]["spec"]
        self.assertEqual(m["metadata"]["name"], "train-run-20261003-abc-a2")
        self.assertEqual(spec["nodeSelector"], {"kubernetes.io/hostname": "son-of-anton"})
        self.assertEqual(spec["containers"][0]["resources"]["limits"]["nvidia.com/gpu"], "1")
        self.assertEqual(spec["tolerations"][0]["value"], "ai")
        self.assertIn("--smoke", spec["containers"][0]["args"])
        self.assertEqual(m["metadata"]["labels"]["burtson.ai/gpu"], "training")
        self.assertFalse(spec["automountServiceAccountToken"])
        env = {e["name"]: e for e in spec["containers"][0]["env"]}
        self.assertEqual(env["RUN_TOKEN"]["value"], "tok")
        self.assertEqual(env["MINIO_SECRET_KEY"]["valueFrom"]["secretKeyRef"]["name"], "training-worker-secrets")


class OllamaTests(unittest.TestCase):
    def test_registration_streams_the_blob_then_creates(self):
        store = storage.MemoryStore()
        store.put_bytes("runs/r/model.q4_k_m.gguf", b"GGUFDATA")
        calls = []

        def handler(request: httpx.Request):
            calls.append((request.method, request.url.path))
            if request.url.path == "/api/version":
                return httpx.Response(200, json={"version": "0.12.0"})
            if request.method == "HEAD":
                return httpx.Response(404)
            if request.url.path.startswith("/api/blobs/"):
                self.assertEqual(request.read(), b"GGUFDATA")
                return httpx.Response(201)
            if request.url.path == "/api/create":
                body = json.loads(request.content)
                self.assertEqual(body["model"], "bandit-local:run_1")
                self.assertIn("<tool_call>", body["template"])
                self.assertEqual(body["parameters"]["num_ctx"], 8192)
                self.assertEqual(list(body["files"].values()), ["sha256:" + "b" * 64])
                return httpx.Response(200, json={"status": "success"})
            return httpx.Response(500)

        registrar = ollama.Registrar(store, "http://ollama", httpx.Client(transport=httpx.MockTransport(handler)))
        db = mongomock.MongoClient()["t"]
        db.runs.insert_one({"_id": "run_1", "status": "completed", "family": "qwen3", "hyper": {"maxSeqLen": 8192},
                            "ollama": {"status": "pending"},
                            "artifacts": {"gguf-q4_k_m": {"key": "runs/r/model.q4_k_m.gguf", "sha256": "b" * 64, "size": 8}}})
        self.assertEqual(ollama.pending_pass(db, registrar, lambda: datetime.now(UTC)), 1)
        self.assertEqual(db.runs.find_one({"_id": "run_1"})["ollama"]["status"], "registered")
        self.assertEqual([c[0] for c in calls], ["GET", "HEAD", "POST", "POST"])

    def test_waits_while_ollama_is_parked(self):
        registrar = ollama.Registrar(storage.MemoryStore(), "http://ollama",
                                     httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503))))
        db = mongomock.MongoClient()["t"]
        db.runs.insert_one({"_id": "run_1", "status": "completed", "ollama": {"status": "pending"}, "artifacts": {}})
        self.assertEqual(ollama.pending_pass(db, registrar, lambda: datetime.now(UTC)), 0)
        self.assertEqual(db.runs.find_one({"_id": "run_1"})["ollama"]["status"], "pending")


class UnitTests(unittest.TestCase):
    def test_secret_shapes(self):
        self.assertEqual(ds.secret_hits("key ghp_" + "a" * 36), ["github"])
        self.assertEqual(ds.secret_hits("mongodb://admin:hunter2@db:27017"), ["conn"])
        self.assertEqual(ds.secret_hits("-----BEGIN RSA PRIVATE KEY-----"), ["pem"])
        self.assertEqual(ds.secret_hits("an ordinary sentence about tokens"), [])

    def test_window_wraps_midnight(self):
        w = Window("22:00", "07:00", "America/Chicago")
        self.assertTrue(w.is_open(NIGHT_CHICAGO))
        self.assertFalse(w.is_open(NOON_CHICAGO))
        self.assertTrue(w.is_open(datetime(2026, 10, 3, 11, 30, tzinfo=UTC)))   # 06:30 CDT
        self.assertFalse(w.is_open(datetime(2026, 10, 3, 12, 30, tzinfo=UTC)))  # 07:30 CDT


if __name__ == "__main__":
    unittest.main()
