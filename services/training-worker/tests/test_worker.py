"""CPU-only worker tests: canonical → chat conversion, the training-api client, and the stage
orchestration with the GPU stages faked (no torch/Unsloth needed)."""
import json
import os
import tempfile
import unittest
from unittest import mock

import httpx

from worker import data, main as worker_main, nas, train
from worker.client import Api, Cancelled


def canonical():
    return {
        "id": "ex_1", "tools": [{"type": "function", "function": {"name": "read_file", "parameters": {}}}],
        "messages": [
            {"role": "system", "content": "You are Bandit."},
            {"role": "user", "content": "Fix it"},
            {"role": "assistant", "content": "Looking.\n```bandit-tl\n{\"tool\":\"read_file\"}\n```\n", "reasoning": "need the file",
             "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\": \"a.ts\"}"}}]},
            {"role": "tool", "tool_call_id": "c1", "name": "read_file", "content": "x"},
            {"role": "assistant", "content": "Fixed.</start_of_turn>"},
            {"role": "user", "content": "thanks"},
        ],
    }


class DataTests(unittest.TestCase):
    def test_to_chat_shapes_for_qwen3_template(self):
        messages, tools = data.to_chat(canonical())
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "tool", "assistant"])   # trailing user trimmed
        call = messages[2]["tool_calls"][0]["function"]
        self.assertEqual(call, {"name": "read_file", "arguments": {"path": "a.ts"}})   # object, not string
        self.assertEqual(messages[2]["content"], "Looking.")                          # bandit-* fence stripped
        self.assertEqual(messages[2]["reasoning_content"], "need the file")
        self.assertEqual(messages[4]["content"], "Fixed.")                            # template leak stripped
        self.assertEqual(tools[0]["function"]["name"], "read_file")

    def test_bad_arguments_survive(self):
        self.assertEqual(data.arguments_object("not json"), {"_raw": "not json"})
        self.assertEqual(data.arguments_object("[1]"), {"value": [1]})

    def test_smoke_examples_are_valid(self):
        rows = data.smoke_examples(6)
        for row in rows:
            messages, _ = data.to_chat(row)
            self.assertEqual(messages[-1]["role"], "assistant")

    def test_latest_checkpoint_orders_numerically(self):
        with tempfile.TemporaryDirectory() as d:
            for step in (5, 50, 10):
                os.makedirs(os.path.join(d, f"checkpoint-{step}"))
            self.assertTrue(train.latest_checkpoint(d).endswith("checkpoint-50"))
            self.assertIsNone(train.latest_checkpoint(os.path.join(d, "nope")))


class ClientTests(unittest.TestCase):
    def test_409_means_cancelled_and_token_header(self):
        seen = []

        def handler(request):
            seen.append(request.headers.get("x-run-token"))
            return httpx.Response(409, text="run is cancelled")

        api = Api("http://api", "run_1", "tok", httpx.Client(transport=httpx.MockTransport(handler), headers={"X-Run-Token": "tok"}))
        with self.assertRaises(Cancelled):
            api.progress(step=1)
        self.assertEqual(seen, ["tok"])


class OrchestrationTests(unittest.TestCase):
    def test_stages_in_order_and_complete(self):
        calls = []

        class FakeApi:
            def spec(self):
                return {**worker_main.SMOKE_SPEC, "runId": "run_x", "exports": ["gguf-q8_0"], "evalBanditBench": True,
                        "ollama": {"template": "t"}}

            def progress(self, **f):
                calls.append(("progress", f.get("status"), f.get("stage")))

            def complete(self, artifacts, eval_result):
                calls.append(("complete", sorted(artifacts), sorted(eval_result)))

            def fail(self, error):
                calls.append(("fail", error))

        with tempfile.TemporaryDirectory() as d, \
                mock.patch.dict(os.environ, {"RUNS_DIR": d}), \
                mock.patch.object(worker_main, "LocalApi", FakeApi), \
                mock.patch.object(train, "run_sft", return_value=(object(), object(), {"train_loss": 0.5})), \
                mock.patch("worker.export.save_adapter", return_value=f"{d}/adapter"), \
                mock.patch("worker.export.merge", return_value=f"{d}/merged"), \
                mock.patch("worker.export.gguf", return_value={"gguf-q8_0": f"{d}/model.q8_0.gguf"}), \
                mock.patch("worker.evaluate.evaluate", return_value={"ollamaProbe": {"ok": True}}) as ev:
            code = worker_main.main(["--local", "--smoke"])
        self.assertEqual(code, 0)
        self.assertEqual(calls[0][1:], ("preparing", "downloading trainset"))
        self.assertIn(("progress", "exporting", "gguf"), calls)
        self.assertEqual(calls[-1], ("complete", ["adapter", "gguf-q8_0", "merged"], ["ollamaProbe", "training"]))
        self.assertTrue(ev.call_args.kwargs["smoke"])

    def test_failure_posts_fail(self):
        failures = []

        class FakeApi(worker_main.LocalApi):
            def fail(self, error):
                failures.append(error)

        with mock.patch.object(worker_main, "LocalApi", FakeApi), \
                mock.patch.object(train, "run_sft", side_effect=RuntimeError("CUDA out of memory")):
            self.assertEqual(worker_main.main(["--local", "--smoke"]), 1)
        self.assertIn("CUDA out of memory", failures[0])


class NasExportTests(unittest.TestCase):
    def test_copy_file_verifies_and_records_a_share_relative_path(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "model.q8_0.gguf")
            with open(src, "wb") as handle:
                handle.write(b"x" * 1000)
            runs = os.path.join(d, "share", "runs")
            os.makedirs(os.path.dirname(runs))
            with mock.patch.dict(os.environ, {"NAS_RUNS_DIR": runs}):
                self.assertEqual(nas.runs_dir(), runs)
            art = nas.copy_file(src, runs, "run_1")
            self.assertEqual(art["location"], "nas")
            self.assertEqual(art["path"], "runs/run_1/model.q8_0.gguf")
            self.assertEqual(art["size"], 1000)
            self.assertTrue(os.path.isfile(os.path.join(runs, "run_1", "model.q8_0.gguf")))
            self.assertFalse(os.path.exists(os.path.join(runs, "run_1", "model.q8_0.gguf.partial")))

    def test_no_share_mounted_means_no_nas(self):
        with mock.patch.dict(os.environ, {"NAS_RUNS_DIR": "/definitely/not/mounted/runs"}):
            self.assertIsNone(nas.runs_dir())

    def test_cluster_run_puts_ggufs_on_the_nas_adapter_in_minio_and_cleans_scratch(self):
        completed = {}

        class FakeApi:
            def __init__(self, *a):
                pass

            def spec(self):
                return {**worker_main.SMOKE_SPEC, "runId": "run_n", "exports": ["gguf-q4_k_m"], "smoke": False,
                        "trainKeys": {"train": "t", "eval": "e"}, "evalBanditBench": False}

            def progress(self, **f):
                pass

            def complete(self, artifacts, eval_result):
                completed.update(artifacts)

            def fail(self, error):
                raise AssertionError(error)

        class FakeBucket:
            def download(self, key, path):
                with open(path, "w") as handle:
                    handle.write("")

            def upload(self, path, key, content_type=None):
                raise AssertionError("GGUF must not go to MinIO when the NAS is mounted")

            def upload_dir(self, directory, prefix):
                return {"prefix": prefix, "files": ["adapter_model.safetensors"]}

        with tempfile.TemporaryDirectory() as d:
            scratch, runs = os.path.join(d, "scratch"), os.path.join(d, "share", "runs")
            os.makedirs(os.path.dirname(runs))
            out_dir = os.path.join(scratch, "run_n")

            def fake_gguf(merged, out, wanted):
                path = os.path.join(out, "model.q4_k_m.gguf")
                with open(path, "wb") as handle:
                    handle.write(b"gguf")
                return {"gguf-q4_k_m": path}

            env = {"RUNS_DIR": scratch, "NAS_RUNS_DIR": runs, "TRAINING_API_URL": "http://api", "RUN_TOKEN": "t"}
            with mock.patch.dict(os.environ, env), \
                    mock.patch.object(worker_main, "Api", FakeApi), \
                    mock.patch.object(worker_main, "Bucket", FakeBucket), \
                    mock.patch.object(worker_main.data, "load_jsonl", return_value=[]), \
                    mock.patch.object(train, "run_sft", return_value=(object(), object(), {"train_loss": 0.5})), \
                    mock.patch("worker.export.save_adapter", return_value=f"{out_dir}/adapter"), \
                    mock.patch("worker.export.merge", return_value=f"{out_dir}/merged"), \
                    mock.patch("worker.export.gguf", side_effect=fake_gguf):
                self.assertEqual(worker_main.main(["--run", "run_n"]), 0)
            self.assertEqual(completed["gguf-q4_k_m"]["location"], "nas")
            self.assertEqual(completed["gguf-q4_k_m"]["path"], "runs/run_n/model.q4_k_m.gguf")
            self.assertEqual(completed["adapter"]["location"], "minio")
            self.assertTrue(os.path.isfile(os.path.join(runs, "run_n", "model.q4_k_m.gguf")))
            self.assertFalse(os.path.exists(out_dir), "scratch should be cleaned after a verified export")


if __name__ == "__main__":
    unittest.main()
