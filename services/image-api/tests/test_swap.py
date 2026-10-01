import os
import shutil
import subprocess
import tempfile
import unittest

from fastapi import HTTPException

from app import estimates as est
from app import main
from app import stitch
from app import swap_workflows as swap


def swap_plan(**overrides):
    values = dict(
        mode="replace", prompt="two people dance", seed=11, resolution="480p", output_fps=24,
        source_width=960, source_height=720, source_frames=465, start_seconds=0.0,
        duration_seconds=5.0, full_length=False,
        subjects=[swap.Subject("p1.png", 0.3, 0.5), swap.Subject("p2.png", 0.7, 0.5)],
    )
    values.update(overrides)
    return swap.plan_swap(**values)


def links_resolve(test, workflow):
    for node in workflow.values():
        for value in node["inputs"].values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                test.assertIn(value[0], workflow)


class WindowPlanTests(unittest.TestCase):
    def test_windows_cover_every_frame_with_overlap(self):
        for frames in (9, 40, 77, 78, 80, 160, 465, 960):
            windows = swap.plan_windows(frames)
            self.assertEqual(windows[0].start, 0)
            self.assertEqual(windows[0].overlap, 0)
            for window in windows:
                self.assertEqual((window.length - 1) % 4, 0, (frames, window))
                self.assertLessEqual(window.length, swap.SEGMENT_FRAMES)
            for previous, current in zip(windows, windows[1:]):
                self.assertEqual(current.overlap, swap.OVERLAP_FRAMES)
                self.assertEqual(current.start, previous.start + previous.length - swap.OVERLAP_FRAMES)
            self.assertGreaterEqual(windows[-1].start + windows[-1].length, frames)
            self.assertLess(windows[-1].start, frames)

    def test_windows_are_balanced(self):
        self.assertEqual([(w.start, w.length, w.overlap) for w in swap.plan_windows(80)], [(0, 45, 0), (40, 41, 5)])
        self.assertEqual([(w.start, w.length, w.overlap) for w in swap.plan_windows(160)],
                         [(0, 57, 0), (52, 57, 5), (104, 57, 5)])
        self.assertEqual(len(swap.plan_windows(77)), 1)
        for frames in range(9, 961, 7):
            windows = swap.plan_windows(frames)
            self.assertGreaterEqual(min(w.length for w in windows), min(frames, 33) if frames > 77 else 9, frames)

    def test_generation_size_keeps_the_source_shape(self):
        self.assertEqual(swap.generation_size(960, 720, "480p"), (736, 544))
        self.assertEqual(swap.generation_size(960, 720, "720p"), (1104, 832))
        self.assertEqual(swap.generation_size(1280, 720, "480p"), (848, 480))
        self.assertEqual(swap.generation_size(720, 1280, "720p"), (720, 1280))
        width, height = swap.output_size(1104, 832, "1080p")
        self.assertEqual(height, 1080)
        self.assertEqual(width % 2, 0)


class SwapPlanTests(unittest.TestCase):
    def test_range_and_full_length(self):
        p = swap_plan(start_seconds=2.0, duration_seconds=5.0)
        self.assertEqual((p.source_start, p.frames, p.duration_seconds), (32, 80, 5.0))
        full = swap_plan(full_length=True, duration_seconds=None)
        self.assertEqual(full.frames, 465)
        capped = swap_plan(full_length=True, source_frames=2000)
        self.assertEqual(capped.frames, 960)  # 60 s cap
        self.assertEqual(p.passes, 2)
        self.assertEqual(p.interpolation, 3)

    def test_invalid_requests(self):
        cases = [
            dict(mode="restyle"),
            dict(mode="animate"),  # two people
            dict(subjects=[]),
            dict(subjects=[swap.Subject(f"p{n}.png", 0.5, 0.5) for n in range(5)]),
            dict(subjects=[swap.Subject("p.png", 1.5, 0.5)]),
            dict(resolution="4k"),
            dict(output_fps=60),
            dict(source_frames=4),
            dict(duration_seconds=None),
        ]
        for overrides in cases:
            with self.assertRaises(ValueError, msg=str(overrides)):
                swap_plan(**overrides)

    def test_animate_is_one_pass(self):
        p = swap_plan(mode="animate", subjects=[swap.Subject("p.png", 0.4, 0.5)])
        self.assertEqual(p.passes, 1)
        self.assertNotIn(swap.RELIGHT_LORA, swap.checkpoints(p))

    def test_estimate_covers_passes_and_windows(self):
        calibration = est.Calibration()
        one = swap.estimate(calibration, swap_plan(subjects=[swap.Subject("p.png", 0.5, 0.5)]))
        two = swap.estimate(calibration, swap_plan())
        self.assertGreater(two["seconds"], one["seconds"])
        self.assertEqual(two["passes"], 2)
        self.assertEqual(two["segments"], 2)
        longer = swap.estimate(calibration, swap_plan(duration_seconds=20))
        self.assertGreater(longer["seconds"], two["seconds"])
        self.assertEqual(calibration.rate(swap.sample_key(swap_plan()))[1], "seeded")


class SwapGraphTests(unittest.TestCase):
    def test_prepare_tracks_one_person_and_saves_three_videos(self):
        p = swap_plan()
        workflow = swap.prepare_workflow(p, 1, "range.mp4", "burtson-swap/x-p2")
        links_resolve(self, workflow)
        self.assertEqual(workflow["track"]["class_type"], "BurtsonSAM2VideoTrack")
        self.assertEqual(workflow["track"]["inputs"]["points"], '[{"x": 0.7, "y": 0.5}]')
        self.assertEqual(workflow["keypoints"]["inputs"]["bboxes"], ["shape", 1])
        self.assertFalse(workflow["pose"]["inputs"]["draw_face"])
        for node in ("save_mask", "save_pose", "save_face"):
            self.assertEqual(workflow[node]["class_type"], "SaveVideo")

    def test_replace_window_keeps_the_scene(self):
        p = swap_plan()
        window = p.windows[1]
        workflow = swap.segment_workflow(p, window=window, pass_index=1, reference="person-2.png",
                                         source_file="s.mp4", pose_file="p.mp4", face_file="f.mp4",
                                         mask_file="m.mp4", tail_file="t.mp4", prefix="x")
        links_resolve(self, workflow)
        cond = workflow["cond"]["inputs"]
        self.assertEqual(cond["background_video"], ["background", 0])
        self.assertEqual(cond["character_mask"], ["mask_threshold", 0])
        self.assertEqual(cond["continue_motion"], ["tail", 0])
        self.assertEqual(cond["video_frame_offset"], swap.OVERLAP_FRAMES)
        self.assertEqual(cond["length"], window.length)
        self.assertEqual(workflow["black"]["inputs"]["batch_size"], window.length)
        self.assertEqual(workflow["lora_relight"]["inputs"]["lora_name"], swap.RELIGHT_LORA)
        self.assertEqual(workflow["save"]["inputs"]["video"], ["save_video", 0])
        self.assertEqual(workflow["save_video"]["inputs"]["images"], ["composite", 0])
        self.assertEqual(workflow["sampler"]["inputs"]["seed"], p.seed + 100 + 1)
        self.assertEqual(workflow["sampler"]["inputs"]["steps"], 6)

    def test_each_pass_can_describe_its_person(self):
        p = swap_plan(subjects=[swap.Subject("p1.png", 0.3, 0.5, "A man in a navy suit."),
                                swap.Subject("p2.png", 0.7, 0.5)])
        first = swap.segment_workflow(p, window=p.windows[0], pass_index=0, reference="a.png", source_file="s",
                                      pose_file="p", face_file="f", mask_file="m", tail_file=None, prefix="x")
        second = swap.segment_workflow(p, window=p.windows[0], pass_index=1, reference="b.png", source_file="s",
                                       pose_file="p", face_file="f", mask_file="m", tail_file=None, prefix="x")
        self.assertEqual(first["positive"]["inputs"]["text"], "A man in a navy suit. two people dance")
        self.assertEqual(second["positive"]["inputs"]["text"], "two people dance")

    def test_animate_window_has_no_background_or_composite(self):
        p = swap_plan(mode="animate", subjects=[swap.Subject("p.png", 0.5, 0.5)], accelerated=False)
        workflow = swap.segment_workflow(p, window=p.windows[0], pass_index=0, reference="person-1.png",
                                         source_file="s.mp4", pose_file="p.mp4", face_file="f.mp4",
                                         mask_file=None, tail_file=None, prefix="x")
        links_resolve(self, workflow)
        self.assertNotIn("background_video", workflow["cond"]["inputs"])
        self.assertNotIn("continue_motion", workflow["cond"]["inputs"])
        self.assertNotIn("composite", workflow)
        self.assertNotIn("lora_relight", workflow)
        self.assertNotIn("lora_distill", workflow)
        self.assertEqual(workflow["sampler"]["inputs"]["steps"], 20)

    def test_finish_upscales_and_interpolates(self):
        p = swap_plan(resolution="1080p", output_fps=30)
        workflow = swap.finish_workflow(p, "c.mp4", "x")
        links_resolve(self, workflow)
        self.assertIn("upscale", workflow)
        self.assertEqual(workflow["interpolate"]["inputs"]["multiplier"], 2)
        self.assertEqual(workflow["save_video"]["inputs"]["fps"], 32.0)

    def test_finish_chunks_share_boundaries(self):
        self.assertEqual(swap.finish_chunks(80), [(0, 80)])
        chunks = swap.finish_chunks(200)
        self.assertEqual(chunks[0], (0, swap.FINISH_CHUNK_FRAMES))
        for previous, current in zip(chunks, chunks[1:]):
            self.assertEqual(current[0], previous[1] - 1)
        self.assertEqual(chunks[-1][1], 200)

    def test_every_model_is_pinned(self):
        p = swap_plan(resolution="1080p")
        self.assertNotIn("unverified", swap.model_digests(p).values())


class SwapApiTests(unittest.TestCase):
    def tearDown(self):
        main.references.clear()
        main.jobs.clear()
        while not main.queue.empty():
            main.queue.get_nowait()

    def setUp(self):
        main.references["src-video-swap"] = main.Reference(
            id="src-video-swap", owner="tester", key="v1/tenant/x/src.mp4", kind="video", filename="vid.mp4",
            contentType="video/mp4", width=960, height=720, bytes=1, durationSeconds=29.0, frames=465,
            sha256="a" * 64, originalSha256="b" * 64, hasAudio=True, audioKey="v1/tenant/x/src.m4a")
        for number in (1, 2):
            main.references[f"photo-person-{number}"] = main.Reference(
                id=f"photo-person-{number}", owner="tester", key=f"v1/tenant/x/p{number}.png", kind="reference",
                filename="p.png", contentType="image/png", width=800, height=1000, bytes=1)

    def request(self, **overrides):
        values = dict(prompt="two people dance", mode="replace", sourceVideoId="src-video-swap",
                      resolution="480p", durationSeconds=10, consent=True,
                      subjects=[{"referenceId": "photo-person-1", "x": 0.3, "y": 0.5},
                                {"referenceId": "photo-person-2", "x": 0.7, "y": 0.5}])
        values.update(overrides)
        return main.VideoRequest(**values)

    def test_swap_job_records_consent_and_plan(self):
        job = main.create_video_job(self.request(), "tester")
        self.assertEqual(job.request["consent"]["statement"], swap.CONSENT_STATEMENT)
        self.assertTrue(job.request["consent"]["confirmed"])
        self.assertEqual(job.request["plan"]["passes"], 2)
        self.assertEqual(job.request["plan"]["segments"], 3)
        self.assertEqual(job.request["plan"]["windows"], [[0, 57, 0], [52, 57, 5], [104, 57, 5]])
        self.assertEqual(job.request["plan"]["generationSize"], [736, 544])
        self.assertEqual(job.request["durationSeconds"], 10.0)
        self.assertTrue(job.request["accelerated"])
        self.assertGreater(job.request["estimate"]["seconds"], 0)
        self.assertGreater(main.estimate_job_seconds(job), 0)
        self.assertEqual(main.public_reference(main.references["src-video-swap"]).get("audioKey"), None)
        self.assertIn("v1/tenant/x/src.m4a", main.pending_input_keys())
        self.assertIn("v1/tenant/x/p2.png", main.pending_input_keys())

    def test_swap_needs_consent_and_one_take(self):
        for overrides in (dict(consent=False), dict(variants=2), dict(model="video-fast"),
                          dict(sourceVideoId=None), dict(mode="animate"),
                          dict(referenceId="photo-person-1")):
            with self.assertRaises(HTTPException, msg=str(overrides)) as caught:
                main.create_video_job(self.request(**overrides), "tester")
            self.assertEqual(caught.exception.status_code, 400)

    def test_subjects_without_a_swap_mode_are_rejected(self):
        with self.assertRaises(HTTPException) as caught:
            main.create_video_job(self.request(mode="restyle"), "tester")
        self.assertEqual(caught.exception.status_code, 400)

    def test_other_users_photo_is_forbidden(self):
        main.references["photo-person-2"].owner = "someone-else"
        with self.assertRaises(HTTPException) as caught:
            main.create_video_job(self.request(), "tester")
        self.assertEqual(caught.exception.status_code, 403)

    def test_estimate_route(self):
        import asyncio

        result = asyncio.run(main.estimate_video(main.EstimateRequest(
            model="video-quality", resolution="480p", hasVideo=True, mode="replace", subjects=2,
            sourceSeconds=29, durationSeconds=10, sourceWidth=960, sourceHeight=720)))
        self.assertTrue(result["valid"])
        self.assertEqual((result["passes"], result["segments"]), (2, 3))
        full = asyncio.run(main.estimate_video(main.EstimateRequest(
            model="video-quality", resolution="480p", hasVideo=True, mode="replace", subjects=1,
            sourceSeconds=29, fullLength=True)))
        self.assertGreater(full["processedSeconds"], 28)
        bad = asyncio.run(main.estimate_video(main.EstimateRequest(
            model="video-quality", hasVideo=True, mode="animate", subjects=2)))
        self.assertFalse(bad["valid"])

    def test_fit_photo_keeps_the_whole_person(self):
        from PIL import Image
        import io

        portrait = Image.new("RGB", (400, 800), (200, 10, 10))
        body = io.BytesIO()
        portrait.save(body, format="PNG")
        fitted = Image.open(io.BytesIO(main.fit_photo(body.getvalue(), 736, 544)))
        self.assertEqual(fitted.size, (736, 544))
        self.assertEqual(fitted.getpixel((368, 10))[:1], (200,))  # photo spans the full height


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class StitchTests(unittest.TestCase):
    def _solid(self, work, name, colour, frames, size="64x48"):
        path = os.path.join(work, name)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        f"color=c={colour}:size={size}:rate=16", "-frames:v", str(frames),
                        "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv444p", path], check=True)
        return path

    def test_windows_join_with_a_crossfade(self):
        with tempfile.TemporaryDirectory() as work:
            windows = swap.plan_windows(160)
            out = os.path.join(work, "out.mp4")
            stitcher = stitch.Stitcher(out, 64, 48, 160, swap.OVERLAP_FRAMES)
            colours = ["black", "white", "black"]
            for window, colour in zip(windows, colours):
                if window.overlap:
                    tail = os.path.join(work, f"tail{window.index}.mp4")
                    stitcher.tail(tail)
                    self.assertEqual(stitch.probe(tail)["frames"], swap.OVERLAP_FRAMES)
                stitcher.add(self._solid(work, f"w{window.index}.mp4", colour, window.length), window.start,
                             window.overlap)
            self.assertEqual(stitcher.close(), 160)
            frames = list(stitch.frames_of(out, 64, 48))
        self.assertEqual(len(frames), 160)
        means = [int(frame.mean()) for frame in frames]
        self.assertEqual([(w.start, w.overlap) for w in windows], [(0, 0), (52, 5), (104, 5)])
        self.assertLess(means[51], 20)            # last frame before the seam: window 1
        self.assertTrue(20 < means[54] < 235)     # mid-crossfade
        self.assertGreater(means[58], 235)        # window 2 after the overlap
        self.assertTrue(20 < means[106] < 235)    # second seam
        self.assertLess(means[159], 20)

    def test_cut_pads_past_the_end(self):
        with tempfile.TemporaryDirectory() as work:
            source = self._solid(work, "s.mp4", "red", 20)
            target = os.path.join(work, "cut.mp4")
            stitch.cut(source, target, start=12, length=17, total=20)
            self.assertEqual(stitch.probe(target)["frames"], 17)

    def test_deliver_trims_audio_to_the_range(self):
        with tempfile.TemporaryDirectory() as work:
            video = self._solid(work, "v.mp4", "blue", 80)
            audio = os.path.join(work, "a.m4a")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
                            "-c:a", "aac", audio], check=True)
            target = os.path.join(work, "final.mp4")
            stitch.deliver(video, target, width=64, height=48, fps=24, crf="18", audio=audio,
                           audio_start=10.0, duration=5.0)
            self.assertTrue(stitch.has_audio(target))
            silent = os.path.join(work, "silent.mp4")
            stitch.deliver(video, silent, width=64, height=48, fps=24, crf="18", audio=None,
                           audio_start=0, duration=5.0)
            self.assertFalse(stitch.has_audio(silent))
            duration = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                             "-of", "csv=p=0", target], capture_output=True, text=True).stdout)
        self.assertAlmostEqual(duration, 5.0, delta=0.15)

    def test_extract_audio(self):
        with tempfile.TemporaryDirectory() as work:
            with_audio = os.path.join(work, "in.mp4")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=16",
                            "-f", "lavfi", "-i", "sine=duration=3", "-t", "3", "-shortest", with_audio], check=True)
            self.assertTrue(stitch.extract_audio(with_audio, os.path.join(work, "a.m4a"), 60))
            silent = self._solid(work, "silent.mp4", "red", 16)
            self.assertFalse(stitch.extract_audio(silent, os.path.join(work, "b.m4a"), 60))


if __name__ == "__main__":
    unittest.main()


class SwapLibraryTests(unittest.TestCase):
    def test_person_photos_and_swap_details_reach_history(self):
        from app import library as lib
        from tests.test_library import DAY, FakeStore, png, seed_video, video_metadata

        store = FakeStore()
        library = lib.Library(store)
        seed_video(store, takes=1)
        store.put(f"{DAY}/references/photoperson1.png", png(), "image/png")
        store.put(f"{DAY}/references/photoperson2.png", png(), "image/png")
        metadata = video_metadata(takes=1, mode="replace", subjects=[
            {"referenceId": "photoperson1", "x": 0.3, "y": 0.5}, {"referenceId": "photoperson2", "x": 0.7, "y": 0.5}])
        metadata["videos"][0]["mode"] = "people-swap"
        metadata["videos"][0]["swap"] = {"mode": "replace", "passes": 2, "segments": 3, "audio": "kept"}
        item = library.record(metadata, tenant_dir=f"{DAY}/job0001video", input_keys={
            "photoperson1": f"{DAY}/references/photoperson1.png",
            "photoperson2": f"{DAY}/references/photoperson2.png"})
        self.assertEqual(item["inputs"], {"person-1": "input-person-1.png", "person-2": "input-person-2.png"})
        self.assertEqual(item["outputs"][0]["swap"]["audio"], "kept")
        self.assertEqual(library.read_file("user-123", "job0001video", "input-person-2.png")[1], "image/png")
