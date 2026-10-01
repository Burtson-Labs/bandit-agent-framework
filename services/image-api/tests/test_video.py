import asyncio
import unittest

from fastapi import HTTPException
from pydantic import ValidationError

from app import main
from app import video_workflows as vw


def plan(**overrides):
    values = dict(
        model="video-fast", prompt="a lighthouse at dusk", seed=7, aspect="16:9",
        resolution="720p", duration_seconds=5, output_fps=24,
    )
    values.update(overrides)
    return vw.plan_video(**values)


def classes(workflow):
    return [node["class_type"] for node in workflow.values()]


class SegmentPlanTests(unittest.TestCase):
    def test_five_seconds_is_one_native_pass(self):
        self.assertEqual(vw.segment_frames(vw.VIDEO_MODELS["video-fast"], 5), (121,))
        self.assertEqual(vw.segment_frames(vw.VIDEO_MODELS["video-quality"], 5), (81,))

    def test_frames_snap_to_4k_plus_1(self):
        for seconds in (2, 3, 3.3, 4.7):
            for frames in vw.segment_frames(vw.VIDEO_MODELS["video-fast"], seconds):
                self.assertEqual((frames - 1) % 4, 0)

    def test_ten_seconds_chains_two_passes(self):
        fast = plan(duration_seconds=10)
        self.assertEqual(fast.segments, (121, 121))
        self.assertEqual(fast.native_frames, 241)
        self.assertEqual(fast.duration_seconds, 10.0)
        quality = plan(model="video-quality", start_image="a.png", duration_seconds=10)
        self.assertEqual(quality.segments, (81, 81))
        self.assertEqual(quality.duration_seconds, 10.0)

    def test_duration_is_clamped(self):
        self.assertEqual(plan(duration_seconds=0.5).duration_seconds, 2.0)
        self.assertEqual(plan(duration_seconds=45).duration_seconds, 10.0)

    def test_interpolation_multiplier(self):
        self.assertEqual(vw.interpolation_multiplier(16, 24), 3)
        self.assertEqual(vw.interpolation_multiplier(16, 30), 2)
        self.assertEqual(vw.interpolation_multiplier(24, 24), 1)
        self.assertEqual(vw.interpolation_multiplier(24, 30), 2)


class PlanValidationTests(unittest.TestCase):
    def test_quality_text_only_uses_t2v_experts(self):
        quality = plan(model="video-quality")
        self.assertEqual(quality.kind, "t2v")
        self.assertEqual(quality.workflow_version, "wan22-t2v-a14b-v1")
        workflow = vw.wan_video_workflow(quality)
        self.assertEqual(workflow["seg1_latent"]["class_type"], "EmptyHunyuanLatentVideo")
        self.assertEqual(workflow["unet_high_t2v"]["inputs"]["unet_name"], vw.EXPERTS["t2v"][0])
        self.assertEqual(workflow["lora_low_t2v"]["inputs"]["lora_name"], vw.LIGHTNING["t2v"][1])
        self.assertNotIn("unet_high", workflow)

    def test_quality_text_only_long_clip_continues_with_i2v(self):
        workflow = vw.wan_video_workflow(plan(model="video-quality", duration_seconds=9))
        self.assertIn("unet_high_t2v", workflow)
        self.assertEqual(workflow["seg2_cond"]["class_type"], "WanImageToVideo")
        self.assertEqual(workflow["seg2_high"]["inputs"]["model"], ["model_high", 0])

    def test_end_frame_requires_quality_and_start(self):
        with self.assertRaises(ValueError):
            plan(end_image="end.png", start_image="a.png")
        with self.assertRaises(ValueError):
            plan(model="video-quality", end_image="end.png")

    def test_first_last_frame_is_single_pass(self):
        flf = plan(model="video-quality", start_image="a.png", end_image="b.png", duration_seconds=9)
        self.assertEqual(flf.segments, (81,))

    def test_aspect_presets(self):
        self.assertEqual((plan(aspect="9:16").gen_width, plan(aspect="9:16").gen_height), (704, 1280))
        vertical = plan(model="video-quality", aspect="9:16", resolution="1080p")
        self.assertEqual((vertical.out_width, vertical.out_height), (1080, 1920))
        square = plan(model="video-quality", start_image="a.png", aspect="1:1", resolution="480p")
        self.assertEqual((square.out_width, square.out_height), (640, 640))

    def test_generation_sizes_respect_model_grid(self):
        for alias, spec in vw.VIDEO_MODELS.items():
            for tier in spec.dimensions.values():
                for width, height in tier.values():
                    self.assertEqual(width % spec.grid, 0, alias)
                    self.assertEqual(height % spec.grid, 0, alias)

    def test_camera_and_fidelity_prompting(self):
        composed = plan(camera="push-in", preserve_text=True).prompt
        self.assertIn("push-in", composed)
        self.assertIn("lettering", composed)
        self.assertEqual(plan(camera="auto").prompt, "a lighthouse at dusk")
        self.assertIn("do not glow", composed)
        guarded = vw.wan_video_workflow(plan(preserve_text=True))["negative"]["inputs"]["text"]
        plain = vw.wan_video_workflow(plan())["negative"]["inputs"]["text"]
        self.assertIn("added text", guarded)
        self.assertNotIn("added text", plain)
        with self.assertRaises(ValueError):
            plan(camera="barrel-roll")


class WorkflowCompilationTests(unittest.TestCase):
    def test_fast_text_to_video(self):
        workflow = vw.wan_video_workflow(plan())
        self.assertIn("Wan22ImageToVideoLatent", classes(workflow))
        self.assertNotIn("start_image", workflow["seg1_latent"]["inputs"])
        self.assertNotIn("LoadImage", classes(workflow))
        self.assertEqual(workflow["seg1_latent"]["inputs"]["length"], 121)
        self.assertEqual(workflow["seg1_sampler"]["inputs"]["seed"], 7)
        # 1280x704 native -> exact 1280x720 delivery size.
        self.assertEqual(workflow["resize"]["inputs"]["height"], 720)
        self.assertNotIn("interpolate", workflow)
        self.assertEqual(workflow["video"]["inputs"]["fps"], 24.0)
        self.assertEqual(workflow["save"]["inputs"]["format"], "mp4")

    def test_fast_image_to_video(self):
        workflow = vw.wan_video_workflow(plan(start_image="photo.png"))
        self.assertEqual(workflow["start_image"]["inputs"]["image"], "photo.png")
        self.assertEqual(workflow["seg1_latent"]["inputs"]["start_image"], ["start_image", 0])

    def test_quality_image_to_video_uses_both_experts(self):
        workflow = vw.wan_video_workflow(plan(
            model="video-quality", start_image="truck.png", resolution="1080p", aspect="16:9",
        ))
        self.assertEqual(workflow["seg1_cond"]["class_type"], "WanImageToVideo")
        high, low = workflow["seg1_high"]["inputs"], workflow["seg1_low"]["inputs"]
        self.assertEqual((high["start_at_step"], high["end_at_step"]), (0, 2))
        self.assertEqual((low["start_at_step"], low["add_noise"]), (2, "disable"))
        self.assertEqual(low["latent_image"], ["seg1_high", 0])
        self.assertEqual(high["cfg"], 1.0)
        self.assertIn("LoraLoaderModelOnly", classes(workflow))
        # 1080p: Real-ESRGAN x2, exact resize, RIFE x3 (16 -> 48 fps).
        self.assertEqual(workflow["upscale_model"]["inputs"]["model_name"], vw.UPSCALE_MODEL)
        self.assertEqual((workflow["resize"]["inputs"]["width"], workflow["resize"]["inputs"]["height"]), (1920, 1080))
        self.assertEqual(workflow["interpolate"]["inputs"]["multiplier"], 3)
        self.assertEqual(workflow["video"]["inputs"]["fps"], 48.0)

    def test_quality_full_schedule_without_lora(self):
        workflow = vw.wan_video_workflow(plan(model="video-quality", start_image="a.png", accelerated=False))
        self.assertNotIn("LoraLoaderModelOnly", classes(workflow))
        self.assertEqual(workflow["seg1_high"]["inputs"]["steps"], 20)
        self.assertEqual(workflow["seg1_high"]["inputs"]["end_at_step"], 10)
        self.assertEqual(workflow["seg1_high"]["inputs"]["cfg"], 3.5)

    def test_lanczos_1080p_skips_model_upscaler(self):
        workflow = vw.wan_video_workflow(plan(model="video-quality", resolution="1080p", upscaler="lanczos"))
        self.assertNotIn("upscale", workflow)
        self.assertEqual(workflow["resize"]["inputs"]["upscale_method"], "lanczos")

    def test_chained_segments_continue_from_last_frame(self):
        workflow = vw.wan_video_workflow(plan(model="video-quality", start_image="a.png", duration_seconds=10))
        self.assertEqual(workflow["seg2_start"]["inputs"], {"image": ["seg1_decode", 0], "batch_index": -1, "length": 1})
        self.assertEqual(workflow["seg2_cond"]["inputs"]["start_image"], ["seg2_start", 0])
        self.assertEqual(workflow["seg2_tail"]["inputs"]["batch_index"], 1)
        self.assertEqual(workflow["seg2_concat"]["inputs"]["image1"], ["seg1_decode", 0])
        self.assertEqual(workflow["seg2_high"]["inputs"]["noise_seed"], 8)

    def test_first_last_frame(self):
        workflow = vw.wan_video_workflow(plan(model="video-quality", start_image="a.png", end_image="b.png"))
        self.assertEqual(workflow["seg1_cond"]["class_type"], "WanFirstLastFrameToVideo")
        self.assertEqual(workflow["seg1_cond"]["inputs"]["end_image"], ["end_image", 0])

    def test_every_link_points_at_an_existing_node(self):
        for candidate in (
            plan(), plan(start_image="a.png", duration_seconds=9, resolution="720p", output_fps=30),
            plan(model="video-quality", start_image="a.png", duration_seconds=10, resolution="1080p"),
            plan(model="video-quality", start_image="a.png", end_image="b.png", accelerated=False),
        ):
            workflow = vw.wan_video_workflow(candidate)
            for node in workflow.values():
                for value in node["inputs"].values():
                    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                        self.assertIn(value[0], workflow)

    def test_sampler_progress_nodes(self):
        self.assertEqual(vw.sampler_nodes(plan(duration_seconds=10)), [("seg1_sampler", 20), ("seg2_sampler", 20)])
        quality = plan(model="video-quality", start_image="a.png")
        self.assertEqual(vw.sampler_nodes(quality), [("seg1_high", 2), ("seg1_low", 2)])

    def test_provenance_lists_only_loaded_models(self):
        quality = plan(model="video-quality", start_image="a.png", accelerated=False, resolution="1080p")
        names = vw.plan_checkpoints(quality)
        self.assertFalse(any("lightx2v" in name for name in names))
        self.assertIn(vw.UPSCALE_MODEL, names)
        self.assertTrue(all(name in vw.CHECKPOINT_SHA256 for name in names))


class VideoEndpointTests(unittest.TestCase):
    def tearDown(self):
        main.references.clear()
        main.jobs.clear()
        while not main.queue.empty():
            main.queue.get_nowait()

    def _reference(self, reference_id="ref-video-test", owner="tester"):
        reference = main.Reference(
            id=reference_id, owner=owner, key="unused", kind="reference",
            filename="truck.png", contentType="image/png", width=1600, height=900, bytes=1024,
        )
        main.references[reference.id] = reference
        return reference

    def test_request_bounds(self):
        with self.assertRaises(ValidationError):
            main.VideoRequest(prompt="ok prompt", variants=5)
        with self.assertRaises(ValidationError):
            main.VideoRequest(prompt="ok prompt", aspect="4:3")
        with self.assertRaises(ValidationError):
            main.VideoRequest(prompt="ok prompt", fps=60)
        with self.assertRaises(ValidationError):
            main.VideoRequest(prompt="ok prompt", camera="barrel-roll")

    def test_quality_text_only_is_accepted(self):
        job = asyncio.run(main.generate_video(main.VideoRequest(prompt="truck", model="video-quality"),
                                              x_burtson_owner="tester"))
        self.assertEqual(job["request"]["plan"]["pipeline"], "t2v")
        self.assertTrue(job["request"]["accelerated"])

    def test_other_users_reference_is_forbidden(self):
        self._reference(owner="someone-else")
        request = main.VideoRequest(prompt="truck", model="video-quality", referenceId="ref-video-test")
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(main.generate_video(request, x_burtson_owner="tester"))
        self.assertEqual(caught.exception.status_code, 403)

    def test_accepted_job_records_plan_and_defaults(self):
        self._reference()
        request = main.VideoRequest(
            prompt="slow reveal of the truck", model="video-quality", referenceId="ref-video-test",
            aspect="16:9", resolution="1080p", durationSeconds=7, variants=3, camera="orbit-left",
        )
        job = asyncio.run(main.generate_video(request, x_burtson_owner="tester"))
        self.assertEqual(job["kind"], "video")
        self.assertEqual(job["status"], "queued")
        self.assertTrue(job["request"]["preserveText"])
        self.assertEqual(job["request"]["plan"]["outputSize"], [1920, 1080])
        self.assertEqual(job["request"]["plan"]["segments"], [81, 33])
        self.assertEqual(job["request"]["durationSeconds"], 7.0)
        self.assertNotIn("assetKeys", job)
        self.assertEqual(main.queue.qsize(), 1)

    def test_text_to_video_fast_is_accepted(self):
        job = asyncio.run(main.generate_video(
            main.VideoRequest(prompt="city timelapse", model="video-fast", aspect="9:16", durationSeconds=4),
            x_burtson_owner="tester"))
        self.assertFalse(job["request"]["preserveText"])
        self.assertEqual(job["request"]["plan"]["outputSize"], [720, 1280])



class DefaultResolutionTests(unittest.TestCase):
    """720p is the default for every mode (Mark, 2026-10-01): best speed/quality mix."""

    def test_requests_default_to_720p(self):
        for extra in ({}, {"referenceId": "ref-start-0001"},
                      {"sourceVideoId": "src-video-0001", "mode": "restyle"}):
            self.assertEqual(main.VideoRequest(prompt="a lighthouse", **extra).resolution, "720p")
        self.assertEqual(main.VideoRequest(prompt="a lighthouse").model, "video-quality")

    def test_estimates_default_to_720p_for_every_mode(self):
        for flags in ({}, {"hasImage": True}, {"hasVideo": True, "mode": "restyle", "control": "edges"}):
            result = asyncio.run(main.estimate_video(main.EstimateRequest(**flags)))
            self.assertTrue(result["valid"], result)
            self.assertEqual(main.EstimateRequest(**flags).resolution, "720p")

if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(__import__("shutil").which("ffmpeg"), "ffmpeg not installed")
class ExecuteVideoTests(unittest.TestCase):
    """Drives execute_video against a fake ComfyUI and captures MinIO uploads."""

    def setUp(self):
        import subprocess
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".mp4") as handle:
            subprocess.run([
                "ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=48",
                "-t", "2.0", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", handle.name,
            ], check=True)
            with open(handle.name, "rb") as clip:
                self.clip = clip.read()

    def tearDown(self):
        main.jobs.clear()
        while not main.queue.empty():
            main.queue.get_nowait()

    def test_variants_are_encoded_uploaded_and_recorded(self):
        from unittest import mock

        import httpx

        prompts = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/system_stats":
                return httpx.Response(200, json={})
            if request.url.path == "/prompt":
                prompts.append(__import__("json").loads(request.content))
                return httpx.Response(200, json={"prompt_id": f"p{len(prompts)}"})
            if request.url.path.startswith("/history/"):
                pid = request.url.path.rsplit("/", 1)[-1]
                return httpx.Response(200, json={pid: {
                    "status": {"status_str": "success", "messages": []},
                    "outputs": {"save": {"images": [{"filename": f"{pid}.mp4", "subfolder": "burtson-video", "type": "output"}]}},
                }})
            if request.url.path == "/view":
                return httpx.Response(200, content=self.clip)
            return httpx.Response(404)

        real_client = httpx.AsyncClient
        uploads = {}

        async def no_sleep(_seconds):
            return None

        async def no_progress(*_args):
            return None

        request = main.VideoRequest(prompt="city timelapse", model="video-fast", aspect="16:9", resolution="720p",
                                    durationSeconds=2, fps=24, variants=2, seed=5)
        job = asyncio.run(main.generate_video(request, x_burtson_owner="tester"))
        stored = main.jobs[job["id"]]
        with mock.patch.object(main.httpx, "AsyncClient",
                               lambda **kw: real_client(transport=httpx.MockTransport(handler), base_url="http://w")), \
             mock.patch.object(main, "upload", lambda key, body, ctype, exp: uploads.__setitem__(key, (ctype, body))), \
             mock.patch.object(main, "watch_progress", no_progress), \
             mock.patch.object(main.asyncio, "sleep", no_sleep):
            asyncio.run(main.execute_video(stored))

        self.assertEqual(stored.status, "completed", stored.error)
        self.assertEqual(len(prompts), 2)
        seeds = [p["prompt"]["seg1_sampler"]["inputs"]["seed"] for p in prompts]
        self.assertEqual(seeds, [5, 1005])
        self.assertEqual(len(stored.videos), 2)
        first = stored.videos[0]
        self.assertEqual((first["codec"], first["pixelFormat"], first["width"], first["height"]), ("h264", "yuv420p", 1280, 720))
        self.assertEqual(first["url"], f"/image/jobs/{stored.id}/assets/0")
        self.assertEqual(first["posterUrl"], f"/image/jobs/{stored.id}/assets/1")
        self.assertEqual(len(stored.assetKeys), 4)
        kinds = sorted(ctype for ctype, _ in uploads.values())
        self.assertEqual(kinds, ["application/json", "image/jpeg", "image/jpeg", "video/mp4", "video/mp4"])
        self.assertNotIn("assetKeys", main.public_job(stored))


def source_plan(**overrides):
    values = dict(
        model="video-quality", prompt="restyled scene", seed=3, aspect="16:9", resolution="720p",
        duration_seconds=5, output_fps=24, source_video="src.mp4", source_frames=161, mode="restyle",
    )
    values.update(overrides)
    return vw.plan_video(**values)


class VideoConditionedPlanTests(unittest.TestCase):
    def test_restyle_edges_graph(self):
        p = source_plan(control="edges", control_strength=0.8, start_image="look.png")
        self.assertEqual((p.kind, p.workflow_version, p.segments), ("vace", "wan22-vace-fun-a14b-v1", (81,)))
        workflow = vw.wan_video_workflow(p)
        self.assertEqual(workflow["source"]["inputs"]["file"], "src.mp4")
        self.assertEqual(workflow["control"]["class_type"], "Canny")
        cond = workflow["seg1_cond"]
        self.assertEqual(cond["class_type"], "WanVaceToVideo")
        self.assertEqual(cond["inputs"]["control_video"], ["control", 0])
        self.assertEqual(cond["inputs"]["reference_image"], ["start_image", 0])
        self.assertEqual(cond["inputs"]["strength"], 0.8)
        self.assertEqual(workflow["seg1_trim"]["inputs"]["trim_amount"], ["seg1_cond", 3])
        self.assertEqual(workflow["seg1_decode"]["inputs"]["samples"], ["seg1_trim", 0])
        self.assertEqual(workflow["unet_high_vace"]["inputs"]["unet_name"], vw.EXPERTS["vace"][0])
        self.assertEqual(workflow["lora_high_vace"]["inputs"]["lora_name"], vw.LIGHTNING["t2v"][0])

    def test_depth_and_pose_controls(self):
        depth = vw.wan_video_workflow(source_plan(control="depth"))
        self.assertEqual(depth["depth_model"]["inputs"]["model_name"], vw.DEPTH_MODEL)
        self.assertEqual(depth["control"]["class_type"], "DA3Render")
        self.assertEqual(depth["control"]["inputs"]["output"], "depth")
        pose = vw.wan_video_workflow(source_plan(mode="motion", start_image="person.png"))
        self.assertEqual(pose["pose_model"]["inputs"]["ckpt_name"], vw.POSE_MODEL)
        self.assertEqual(pose["control"]["class_type"], "SDPoseDrawKeypoints")
        self.assertEqual(pose["pose"]["inputs"]["vae"], ["pose_model", 2])

    def test_mode_defaults(self):
        self.assertEqual(source_plan().control, "edges")
        self.assertEqual(source_plan(mode="motion", start_image="a.png").control, "pose")
        self.assertIsNone(source_plan(mode="extend", control="depth").control)

    def test_restyle_window_is_clamped_to_source(self):
        p = source_plan(source_frames=49, duration_seconds=5, source_start_seconds=9)
        self.assertEqual(p.source_start, 49 - vw.MIN_SEGMENT_FRAMES)
        self.assertEqual(p.segments, (17,))
        p = source_plan(source_frames=161, duration_seconds=3, source_start_seconds=2)
        self.assertEqual((p.source_start, p.segments), (32, (49,)))
        workflow = vw.wan_video_workflow(p)
        self.assertEqual(workflow["source_window"]["inputs"]["batch_index"], 32)
        self.assertEqual(workflow["source_window"]["inputs"]["length"], 49)

    def test_extend_appends_after_the_source(self):
        p = source_plan(mode="extend", duration_seconds=3, source_frames=81)
        self.assertEqual(p.segments, (65,))  # 17 context + 48 new
        self.assertEqual(p.native_frames, 81 + 65 - 17)
        workflow = vw.wan_video_workflow(p)
        cond = workflow["seg1_cond"]["inputs"]
        self.assertEqual(cond["control_video"], ["source_tail", 0])
        self.assertEqual(cond["control_masks"], ["keep_mask", 0])
        self.assertEqual(workflow["source_tail"]["inputs"]["batch_index"], -vw.EXTEND_CONTEXT_FRAMES)
        self.assertEqual(workflow["keep_frames"]["inputs"]["color"], 0)
        self.assertEqual(workflow["extension"]["inputs"]["batch_index"], vw.EXTEND_CONTEXT_FRAMES)
        self.assertEqual(workflow["extended"]["inputs"]["image1"], ["source_scaled", 0])
        self.assertNotIn("control", workflow)

    def test_invalid_combinations(self):
        cases = [
            dict(model="video-fast"),
            dict(mode=None),
            dict(mode="motion"),  # no reference image
            dict(start_image="a.png", end_image="b.png"),
            dict(control="sketch"),
            dict(control_strength=3.0),
            dict(source_frames=10),
        ]
        for overrides in cases:
            with self.assertRaises(ValueError, msg=str(overrides)):
                source_plan(**overrides)
        with self.assertRaises(ValueError):
            plan(mode="restyle")  # mode without a source video

    def test_links_and_provenance_for_every_mode(self):
        for candidate in (
            source_plan(control="edges", resolution="1080p"),
            source_plan(control="depth", aspect="9:16", accelerated=False),
            source_plan(mode="motion", start_image="a.png", output_fps=30),
            source_plan(mode="extend", start_image="a.png", resolution="1080p"),
        ):
            workflow = vw.wan_video_workflow(candidate)
            for node in workflow.values():
                for value in node["inputs"].values():
                    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                        self.assertIn(value[0], workflow)
            names = vw.plan_checkpoints(candidate)
            self.assertTrue(all(name in vw.CHECKPOINT_SHA256 for name in names), names)


class SourceVideoTests(unittest.TestCase):
    def tearDown(self):
        main.references.clear()
        main.jobs.clear()
        while not main.queue.empty():
            main.queue.get_nowait()

    def _source(self, owner="tester", frames=161):
        reference = main.Reference(
            id="src-video-test", owner=owner, key="unused", kind="video", filename="clip.mp4",
            contentType="video/mp4", width=1280, height=720, bytes=1024, durationSeconds=10.0,
            frames=frames, sha256="a" * 64, originalSha256="b" * 64,
        )
        main.references[reference.id] = reference
        return reference

    def _image(self):
        reference = main.Reference(
            id="ref-image-test", owner="tester", key="unused", kind="reference", filename="p.png",
            contentType="image/png", width=800, height=800, bytes=10,
        )
        main.references[reference.id] = reference

    def submit(self, **fields):
        return asyncio.run(main.generate_video(main.VideoRequest(prompt="make it painterly", **fields),
                                               x_burtson_owner="tester"))

    def test_restyle_job_records_source_digest(self):
        self._source()
        job = self.submit(model="video-quality", sourceVideoId="src-video-test", mode="restyle", control="depth")
        self.assertEqual(job["request"]["plan"]["pipeline"], "vace")
        self.assertEqual(job["request"]["plan"]["control"], "depth")
        self.assertEqual(job["request"]["sourceSha256"], "a" * 64)
        self.assertFalse(job["request"]["accelerated"])
        self.assertEqual(job["request"]["plan"]["steps"], 20)

    def test_motion_without_image_is_400(self):
        self._source()
        with self.assertRaises(HTTPException) as caught:
            self.submit(model="video-quality", sourceVideoId="src-video-test", mode="motion")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("reference image", caught.exception.detail)

    def test_source_on_fast_model_is_400(self):
        self._source()
        with self.assertRaises(HTTPException) as caught:
            self.submit(model="video-fast", sourceVideoId="src-video-test", mode="restyle")
        self.assertEqual(caught.exception.status_code, 400)

    def test_image_id_is_not_a_source_video(self):
        self._image()
        with self.assertRaises(HTTPException) as caught:
            self.submit(model="video-quality", sourceVideoId="ref-image-test", mode="restyle")
        self.assertEqual(caught.exception.status_code, 400)

    def test_other_users_source_is_forbidden(self):
        self._source(owner="someone-else")
        with self.assertRaises(HTTPException) as caught:
            self.submit(model="video-quality", sourceVideoId="src-video-test", mode="extend")
        self.assertEqual(caught.exception.status_code, 403)

    def test_request_bounds(self):
        with self.assertRaises(ValidationError):
            main.VideoRequest(prompt="ok prompt", mode="inpaint")
        with self.assertRaises(ValidationError):
            main.VideoRequest(prompt="ok prompt", controlStrength=5)


@unittest.skipUnless(__import__("shutil").which("ffmpeg"), "ffmpeg not installed")
class SourceNormalizationTests(unittest.TestCase):
    def _make(self, work, name, args):
        import os
        import subprocess

        path = os.path.join(work, name)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args, path], check=True)
        return path

    def test_long_4k_clip_is_trimmed_resampled_and_downscaled(self):
        import tempfile

        with tempfile.TemporaryDirectory() as work:
            path = self._make(work, "in.mov", ["-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30",
                                               "-t", "12", "-c:v", "libx264", "-preset", "ultrafast"])
            body, info = main.normalize_source_video(path, work)
        self.assertEqual((info["width"], info["height"]), (1280, 720))
        self.assertEqual(info["frames"], 160)
        self.assertEqual(info["originalDuration"], 12.0)
        self.assertEqual(info["codec"], "h264")
        self.assertGreater(len(body), 1000)

    def test_portrait_keeps_orientation(self):
        import tempfile

        with tempfile.TemporaryDirectory() as work:
            path = self._make(work, "in.mp4", ["-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=24", "-t", "2"])
            _, info = main.normalize_source_video(path, work)
        self.assertEqual((info["width"], info["height"]), (720, 1280))

    def test_still_image_and_garbage_are_rejected(self):
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as work:
            still = self._make(work, "still.png", ["-f", "lavfi", "-i", "color=c=red:size=64x64", "-frames:v", "1"])
            junk = os.path.join(work, "junk.mp4")
            with open(junk, "wb") as handle:
                handle.write(b"not a video" * 100)
            for path in (still, junk):
                with self.assertRaises(HTTPException) as caught:
                    main.normalize_source_video(path, work)
                self.assertEqual(caught.exception.status_code, 400)
