import asyncio
import json
import time
import unittest

from fastapi import HTTPException
from pydantic import ValidationError

from app import estimates as est
from app import image_models as im
from app import main


def links(workflow: dict) -> list[tuple[str, str, str]]:
    """(node, input, upstream node) for every link in an API graph."""
    found = []
    for node_id, node in workflow.items():
        for name, value in node["inputs"].items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                found.append((node_id, name, value[0]))
    return found


def nodes_of(workflow: dict, class_type: str) -> list[dict]:
    return [node for node in workflow.values() if node["class_type"] == class_type]


class RegistryTests(unittest.TestCase):
    def test_every_model_is_apache_and_public(self):
        self.assertEqual(set(im.MODEL_IDS), set(im.ModelId.__args__))
        for model in im.MODELS.values():
            self.assertEqual(model.license, "Apache-2.0")
            public = model.public()
            self.assertEqual(public["id"], model.id)
            self.assertIn("@", public["revision"])
            self.assertTrue(model.files)
            self.assertIn(model.id, im.BUILDERS)
            self.assertIn(model.id, im.SAMPLER_NODES)
            self.assertIn(model.id, est.IMAGE_STEP_SECONDS)

    def test_non_commercial_klein_9b_is_not_offered(self):
        for model in im.MODELS.values():
            self.assertNotIn("9b", model.id.lower())
            self.assertFalse(any("9b" in name.lower() for name in model.files))

    def test_models_endpoint_lists_registry(self):
        result = asyncio.run(main.list_image_models())
        self.assertEqual(result["default"], "flux-schnell")
        self.assertEqual({m["id"] for m in result["models"]}, set(im.MODEL_IDS))
        klein = next(m for m in result["models"] if m["id"] == "flux2-klein-4b")
        self.assertTrue(klein["capabilities"]["multiReference"])
        self.assertEqual(klein["tier"], "Balanced")


class PlanTests(unittest.TestCase):
    def test_defaults_per_model(self):
        expected = {"flux-schnell": 4, "z-image-turbo": 8, "flux2-klein-4b": 4, "qwen-image": 30}
        for model, steps in expected.items():
            plan = im.plan_image(model, width=1024, height=1024, steps=None)
            self.assertEqual((plan.steps, plan.mode, plan.model.id), (steps, "generate", model))

    def test_quality_with_reference_runs_the_edit_model(self):
        plan = im.plan_image("qwen-image", width=1024, height=768, steps=None, references=2)
        self.assertEqual(plan.model.id, "qwen-image-edit")
        self.assertEqual(plan.requested, "qwen-image")
        self.assertEqual((plan.mode, plan.steps), ("edit", 20))

    def test_edit_model_needs_a_reference(self):
        with self.assertRaisesRegex(ValueError, "attach a reference"):
            im.plan_image("qwen-image-edit", width=1024, height=1024, steps=None)

    def test_reference_limits(self):
        im.plan_image("flux2-klein-4b", width=1024, height=1024, steps=None, references=4)
        with self.assertRaisesRegex(ValueError, "at most 4"):
            im.plan_image("flux2-klein-4b", width=1024, height=1024, steps=None, references=5)
        with self.assertRaisesRegex(ValueError, "at most 1 reference image$"):
            im.plan_image("z-image-turbo", width=1024, height=1024, steps=None, references=2)
        with self.assertRaisesRegex(ValueError, "at most 3"):
            im.plan_image("qwen-image", width=1024, height=1024, steps=None, references=4)

    def test_mask_is_flux_schnell_only(self):
        im.plan_image("flux-schnell", width=1024, height=1024, steps=None, references=1, mask=True)
        with self.assertRaisesRegex(ValueError, "masked edits need FLUX.1 Schnell"):
            im.plan_image("flux2-klein-4b", width=1024, height=1024, steps=None, references=1, mask=True)

    def test_size_and_step_limits(self):
        im.plan_image("qwen-image", width=2048, height=2048, steps=50)
        with self.assertRaisesRegex(ValueError, "1536 px"):
            im.plan_image("flux-schnell", width=2048, height=1024, steps=None)
        with self.assertRaisesRegex(ValueError, "1-8 steps"):
            im.plan_image("flux2-klein-4b", width=1024, height=1024, steps=20)

    def test_strength_only_where_img2img_applies(self):
        self.assertEqual(im.plan_image("z-image-turbo", width=1024, height=1024, steps=None,
                                       references=1, strength=0.4).strength, 0.4)
        self.assertIsNone(im.plan_image("flux2-klein-4b", width=1024, height=1024, steps=None,
                                        references=1, strength=0.4).strength)
        self.assertIsNone(im.plan_image("z-image-turbo", width=1024, height=1024, steps=None,
                                        strength=0.4).strength)


class WorkflowCompileTests(unittest.TestCase):
    CASES = [
        ("flux-schnell", 0, False), ("flux-schnell", 1, False), ("flux-schnell", 1, True),
        ("z-image-turbo", 0, False), ("z-image-turbo", 1, False),
        ("flux2-klein-4b", 0, False), ("flux2-klein-4b", 1, False), ("flux2-klein-4b", 4, False),
        ("qwen-image", 0, False), ("qwen-image", 1, False), ("qwen-image-edit", 3, False),
    ]

    def compile(self, model: str, references: int, mask: bool):
        plan = im.plan_image(model, width=1344, height=768, steps=None, references=references,
                             mask=mask, strength=0.5)
        names = [f"ref{i}.png" for i in range(references)]
        workflow = im.build_workflow(plan, "a BURTSON LABS sign", 1234, reference_names=names,
                                     mask_name="mask.png" if mask else None, filename_prefix="t")
        return plan, workflow

    def test_every_graph_is_closed_and_saves_one_image(self):
        for model, references, mask in self.CASES:
            with self.subTest(model=model, references=references, mask=mask):
                plan, workflow = self.compile(model, references, mask)
                for node, name, upstream in links(workflow):
                    self.assertIn(upstream, workflow, f"{node}.{name} -> missing {upstream}")
                self.assertEqual(workflow[im.OUTPUT_NODE]["class_type"], "SaveImage")
                self.assertEqual(len(nodes_of(workflow, "SaveImage")), 1)
                self.assertNotIn("_decoded", workflow)
                self.assertIn(im.sampler_node(plan), workflow)
                loaded = [name for node in workflow.values() for key, name in node["inputs"].items()
                          if key in {"ckpt_name", "unet_name", "clip_name", "vae_name"}]
                self.assertTrue(loaded)
                for name in loaded:
                    self.assertIn(name, plan.model.files, f"{model} loads an unregistered file {name}")
                images = [node["inputs"]["image"] for node in nodes_of(workflow, "LoadImage")]
                expected = [f"ref{i}.png" for i in range(references)] + (["mask.png"] if mask else [])
                self.assertEqual(sorted(images), sorted(expected))
                prompts = json.dumps(workflow)
                self.assertIn("a BURTSON LABS sign", prompts)

    def test_seed_steps_and_canvas_reach_the_sampler(self):
        plan, workflow = self.compile("qwen-image", 0, False)
        sampler = workflow[im.sampler_node(plan)]["inputs"]
        self.assertEqual((sampler["seed"], sampler["steps"], sampler["cfg"]), (1234, 30, 4.0))
        self.assertEqual(workflow["7"]["inputs"]["width"], 1344)
        plan, workflow = self.compile("flux2-klein-4b", 0, False)
        self.assertEqual(workflow["10"]["inputs"]["noise_seed"], 1234)
        self.assertEqual(workflow["7"]["inputs"], {"steps": 4, "width": 1344, "height": 768})
        self.assertEqual(workflow["8"]["inputs"]["cfg"], 1.0)

    def test_klein_chains_every_reference_onto_both_conditionings(self):
        _, workflow = self.compile("flux2-klein-4b", 4, False)
        self.assertEqual(len(nodes_of(workflow, "ReferenceLatent")), 8)
        guider = workflow["8"]["inputs"]
        self.assertEqual(guider["positive"], ["333", 0])
        self.assertEqual(guider["negative"], ["334", 0])
        self.assertEqual(workflow["333"]["inputs"]["conditioning"], ["323", 0])

    def test_qwen_edit_passes_three_pictures_and_uses_the_2511_method(self):
        plan, workflow = self.compile("qwen-image-edit", 3, False)
        encoders = nodes_of(workflow, "TextEncodeQwenImageEditPlus")
        self.assertEqual(len(encoders), 2)
        for encoder in encoders:
            self.assertEqual({"image1", "image2", "image3"} & set(encoder["inputs"]), {"image1", "image2", "image3"})
        methods = {n["inputs"]["reference_latents_method"] for n in nodes_of(workflow, "FluxKontextMultiReferenceLatentMethod")}
        self.assertEqual(methods, {"index_timestep_zero"})
        # Picture 1 is scaled to the canvas and is also the starting latent.
        self.assertEqual(workflow["21"]["inputs"]["width"], 1344)
        self.assertEqual(workflow["10"]["inputs"]["pixels"], ["21", 0])
        self.assertEqual(workflow[im.sampler_node(plan)]["inputs"]["denoise"], 1.0)

    def test_z_image_img2img_uses_strength_as_denoise(self):
        plan, workflow = self.compile("z-image-turbo", 1, False)
        self.assertEqual(workflow["7"]["class_type"], "VAEEncode")
        self.assertEqual(workflow[im.sampler_node(plan)]["inputs"]["denoise"], 0.5)
        _, workflow = self.compile("z-image-turbo", 0, False)
        self.assertEqual(workflow["7"]["class_type"], "EmptySD3LatentImage")

    def test_flux_schnell_graph_is_the_v1_graph(self):
        from app.workflows import flux_workflow

        plan, workflow = self.compile("flux-schnell", 1, True)
        original = flux_workflow("a BURTSON LABS sign", 1344, 768, 4, 1234, reference_name="ref0.png",
                                 mask_name="mask.png", strength=0.5)
        original.pop("7")
        for node_id, node in original.items():
            self.assertEqual(workflow[node_id], node)
        self.assertEqual(workflow[im.OUTPUT_NODE]["inputs"]["images"], ["6", 0])

    def test_reference_count_must_match_plan(self):
        plan = im.plan_image("flux2-klein-4b", width=1024, height=1024, steps=None, references=2)
        with self.assertRaises(ValueError):
            im.build_workflow(plan, "x", 1, reference_names=["only-one.png"])


class RequestValidationTests(unittest.TestCase):
    def setUp(self):
        main.warm_image_model = None

    def tearDown(self):
        main.references.clear()
        main.jobs.clear()
        while not main.queue.empty():
            main.queue.get_nowait()
        main.warm_image_model = None

    def _reference(self, ref_id: str, kind: str = "reference", owner: str = "tester") -> None:
        main.references[ref_id] = main.Reference(
            id=ref_id, owner=owner, key=f"k/{ref_id}.png", kind=kind, filename="x.png",
            contentType="image/png", width=1024, height=768, bytes=10,
        )

    def submit(self, **fields) -> dict:
        return asyncio.run(main.generate(main.GenerationRequest(**fields), x_burtson_owner="tester"))

    def test_unknown_model_is_rejected(self):
        with self.assertRaises(ValidationError):
            main.GenerationRequest(prompt="a robot", model="flux2-klein-9b")

    def test_default_request_is_unchanged_flux_schnell(self):
        job = self.submit(prompt="a brass robot")
        request = job["request"]
        self.assertEqual((request["model"], request["steps"]), ("flux-schnell", 4))
        self.assertEqual(request["plan"]["workflowVersion"], "flux-schnell-v1")
        self.assertIsNone(request["strength"])

    def test_model_and_estimate_recorded_at_submit(self):
        job = self.submit(prompt="a brass robot", model="flux2-klein-4b")
        self.assertEqual(job["request"]["model"], "flux2-klein-4b")
        self.assertEqual(job["request"]["estimate"]["key"], "image|flux2-klein-4b|generate|s4")
        self.assertGreater(job["request"]["estimate"]["loadSeconds"], 0)

    def test_quality_edit_resolves_and_keeps_requested_model(self):
        self._reference("ref-person-0001")
        self._reference("ref-dog-000001")
        job = self.submit(prompt="put the dog's head on the person", model="qwen-image",
                          referenceId="ref-person-0001", extraReferenceIds=["ref-dog-000001"])
        request = job["request"]
        self.assertEqual((request["model"], request["requestedModel"]), ("qwen-image-edit", "qwen-image"))
        self.assertEqual(request["plan"]["references"], 2)
        self.assertEqual(request["steps"], 20)

    def test_invalid_combinations_are_400(self):
        self._reference("ref-person-0001")
        self._reference("mask-000000001", kind="mask")
        cases = [
            dict(prompt="edit", model="qwen-image-edit"),
            dict(prompt="edit", model="flux2-klein-4b", referenceId="ref-person-0001", maskId="mask-000000001"),
            dict(prompt="edit", model="flux-schnell", width=2048, height=1024),
            dict(prompt="edit", model="z-image-turbo", steps=40),
            dict(prompt="edit", model="flux2-klein-4b", extraReferenceIds=["ref-person-0001"]),
        ]
        for fields in cases:
            with self.subTest(fields=fields), self.assertRaises(HTTPException) as caught:
                self.submit(**fields)
            self.assertEqual(caught.exception.status_code, 400)

    def test_extra_references_must_be_owned(self):
        self._reference("ref-person-0001")
        self._reference("ref-someone-01", owner="someone-else")
        with self.assertRaises(HTTPException) as caught:
            self.submit(prompt="combine", model="flux2-klein-4b", referenceId="ref-person-0001",
                        extraReferenceIds=["ref-someone-01"])
        self.assertEqual(caught.exception.status_code, 403)

    def test_too_many_extra_references_is_a_validation_error(self):
        with self.assertRaises(ValidationError):
            main.GenerationRequest(prompt="x" * 5, extraReferenceIds=["a" * 8] * 4)

    def test_queue_eta_uses_the_model_estimate(self):
        job = self.submit(prompt="a brass robot", model="qwen-image")
        seconds = main.estimate_job_seconds(main.jobs[job["id"]])
        self.assertEqual(seconds, job["request"]["estimate"]["seconds"])
        self.assertGreater(seconds, 30)


class ImageEstimateTests(unittest.TestCase):
    def setUp(self):
        self.calibration = est.Calibration()

    def plan(self, model="flux2-klein-4b", **kw):
        return im.plan_image(model, width=kw.pop("width", 1024), height=kw.pop("height", 1024),
                             steps=kw.pop("steps", None), **kw)

    def test_seeded_estimate_orders_models_by_cost(self):
        seconds = {m: est.estimate_image(self.calibration, self.plan(m), warm_model=m)["seconds"]
                   for m in ("z-image-turbo", "flux2-klein-4b", "qwen-image")}
        self.assertLess(seconds["flux2-klein-4b"], seconds["qwen-image"])
        self.assertLess(seconds["z-image-turbo"], seconds["qwen-image"])

    def test_warm_model_skips_the_load(self):
        cold = est.estimate_image(self.calibration, self.plan())
        warm = est.estimate_image(self.calibration, self.plan(), warm_model="flux2-klein-4b")
        other = est.estimate_image(self.calibration, self.plan(), warm_model="qwen-image")
        self.assertEqual(warm["loadSeconds"], 0)
        self.assertTrue(warm["modelWarm"])
        self.assertEqual(cold["seconds"] - warm["seconds"], cold["loadSeconds"])
        self.assertEqual(other["loadSeconds"], cold["loadSeconds"])

    def test_more_steps_and_pixels_cost_more(self):
        base = est.estimate_image(self.calibration, self.plan("qwen-image"), warm_model="qwen-image")
        steps = est.estimate_image(self.calibration, self.plan("qwen-image", steps=50), warm_model="qwen-image")
        big = est.estimate_image(self.calibration, self.plan("qwen-image", width=2048, height=2048),
                                 warm_model="qwen-image")
        self.assertGreater(steps["seconds"], base["seconds"])
        self.assertGreater(big["seconds"], base["seconds"] * 3)

    def test_measurements_replace_the_seed_and_loads_are_per_model(self):
        plan = self.plan()
        key = est.image_key(plan)
        for rate, load in ((10.0, 30.0), (12.0, 32.0), (11.0, 31.0)):
            self.calibration.record(key, rate, load, load_model="flux2-klein-4b")
        estimate = est.estimate_image(self.calibration, plan)
        self.assertEqual((estimate["basis"], estimate["samples"]), ("measured", 3))
        self.assertEqual(estimate["perImageSeconds"], 11.0)
        self.assertEqual(estimate["loadSeconds"], 31)
        # Other models and video keep their own load figures.
        self.assertEqual(self.calibration.load_seconds("qwen-image"), est.IMAGE_LOAD_SEEDS["qwen-image"])
        self.assertEqual(self.calibration.load_seconds(), est.MODEL_LOAD_SECONDS)

    def test_model_loads_survive_persistence(self):
        self.calibration.record("image|qwen-image|generate|s30", 40.0, 50.0, load_model="qwen-image")
        restored = est.Calibration()
        restored.load_json(self.calibration.to_json())
        self.assertEqual(restored.model_loads, {"qwen-image": [50.0]})
        self.assertEqual(restored.samples["image|qwen-image|generate|s30"], [40.0])

    def test_estimate_routes(self):
        result = asyncio.run(main.estimate_any({"kind": "image", "model": "z-image-turbo", "width": 1344,
                                                "height": 768}))
        self.assertTrue(result["valid"])
        self.assertEqual(result["kind"], "image")
        self.assertEqual(result["key"], "image|z-image-turbo|generate|s8")
        invalid = asyncio.run(main.estimate_any({"kind": "image", "model": "qwen-image-edit"}))
        self.assertFalse(invalid["valid"])
        self.assertIn("attach a reference", invalid["error"])
        video = asyncio.run(main.estimate_any({"model": "video-fast", "resolution": "480p"}))
        self.assertTrue(video["valid"])
        self.assertIn("pipeline", video)
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(main.estimate_any({"kind": "image", "model": "nope"}))
        self.assertEqual(caught.exception.status_code, 422)

    def test_record_image_timing_splits_cold_load(self):
        original_calibration, original_write = main.calibration, main.write_stats
        main.calibration = calibration = est.Calibration()
        try:
            plan = self.plan()
            now = time.monotonic()
            main.write_stats = lambda: None  # no MinIO in tests
            main.record_image_timing(plan, now - 40, now - 10, now, warm=False)
            self.assertEqual(calibration.model_loads["flux2-klein-4b"], [30.0])
            self.assertEqual(calibration.samples[est.image_key(plan)], [10.0])
            main.record_image_timing(plan, now - 12, now - 11, now, warm=True)
            self.assertEqual(calibration.model_loads["flux2-klein-4b"], [30.0])
            self.assertEqual(calibration.samples[est.image_key(plan)], [10.0, 11.0])
        finally:
            main.calibration, main.write_stats = original_calibration, original_write


if __name__ == "__main__":
    unittest.main()


class LibraryMultiReferenceTests(unittest.TestCase):
    def test_every_reference_is_kept_for_remix(self):
        from app import library as lib
        from tests.test_library import DAY, OWNER, FakeStore, png

        store = FakeStore()
        library = lib.Library(store)
        store.put(f"{DAY}/job0009multi/image-01.png", png(), "image/png")
        for name in ("refperson", "refdog001", "refhat001"):
            store.put(f"{DAY}/references/{name}.png", png((64, 64)), "image/png")
        meta = {"jobId": "job0009multi", "owner": OWNER, "createdAt": "2026-10-01T09:00:00+00:00",
                "request": {"prompt": "dog head on the person", "model": "qwen-image-edit",
                            "requestedModel": "qwen-image", "seed": 3, "referenceId": "refperson",
                            "extraReferenceIds": ["refdog001", "refhat001"]},
                "images": [{"key": f"{DAY}/job0009multi/image-01.png", "width": 1024, "height": 1024,
                            "seed": 3, "model": "qwen-image-edit", "mode": "edit"}]}
        keys = {name: f"{DAY}/references/{name}.png" for name in ("refperson", "refdog001", "refhat001")}
        item = library.record(meta, input_keys=keys)
        self.assertEqual(item["inputs"], {"reference": "input-reference.png", "reference2": "input-reference2.png",
                                          "reference3": "input-reference3.png"})
        self.assertEqual(item["model"], "qwen-image-edit")
        body, content_type = library.read_file(OWNER, "job0009multi", "input-reference3.png")
        self.assertEqual(content_type, "image/png")
        self.assertTrue(body)
