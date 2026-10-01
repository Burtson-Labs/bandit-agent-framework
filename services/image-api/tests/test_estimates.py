import asyncio
import unittest
from datetime import UTC, datetime, timedelta
from unittest import mock

import httpx

from app import estimates as est
from app import main
from app import video_workflows as vw


def plan(**overrides):
    values = dict(model="video-quality", prompt="p", seed=1, aspect="16:9", resolution="720p",
                  duration_seconds=5, output_fps=24)
    values.update(overrides)
    return vw.plan_video(**values)


def video_job(job_id, *, owner="tester", status="queued", variants=1, **request):
    payload = dict(model="video-quality", prompt="p", seed=1, aspect="16:9", resolution="1080p",
                   durationSeconds=5, fps=24, camera="auto", preserveText=False, accelerated=True,
                   upscaler="esrgan", variants=variants, referenceId="ref-x")
    payload.update(request)
    job = main.Job(id=job_id, owner=owner, request=payload, kind="video", status=status)
    main.jobs[job_id] = job
    return job


class CalibrationTests(unittest.TestCase):
    def test_seeded_lookup_and_scaling(self):
        cal = est.Calibration()
        five = est.estimate_plan(cal, plan(start_image="a.png", resolution="1080p"), 1)
        self.assertEqual(five["key"], "i2v|video-quality|1080p|lightning")
        self.assertEqual(five["basis"], "seeded")
        self.assertEqual(five["perTakeSeconds"], 200)  # 40 s/s x 5 s
        self.assertEqual(five["seconds"], 240)  # + 40 s model load
        ten = est.estimate_plan(cal, plan(start_image="a.png", resolution="1080p", duration_seconds=10), 3)
        self.assertEqual(ten["perTakeSeconds"], 400)
        self.assertEqual(ten["seconds"], 40 + 3 * 400)

    def test_keys_cover_schedule_draft_and_vace(self):
        self.assertEqual(est.key_of(plan(accelerated=False)), "t2v|video-quality|720p|full")
        self.assertEqual(est.key_of(plan(model="video-fast")), "t2v|video-fast|720p|steps20")
        vace = plan(source_video="s.mp4", source_frames=161, mode="restyle", accelerated=False, resolution="480p")
        self.assertEqual(est.key_of(vace), "vace|video-quality|480p|full")
        self.assertAlmostEqual(est.estimate_plan(est.Calibration(), vace, 1)["perTakeSeconds"], 385, delta=1)

    def test_extend_counts_generated_frames_not_the_source(self):
        p = plan(source_video="s.mp4", source_frames=161, mode="extend", duration_seconds=3)
        self.assertAlmostEqual(est.generated_seconds(p), (65 - 1) / 16)

    def test_every_valid_combination_has_a_seed(self):
        cal = est.Calibration()
        for model in ("video-fast", "video-quality"):
            for resolution in ("480p", "720p", "1080p"):
                for kw in ({}, {"start_image": "a"}, {"source_video": "s", "source_frames": 81, "mode": "restyle"}):
                    for accelerated in (True, False):
                        try:
                            p = plan(model=model, resolution=resolution, accelerated=accelerated, **kw)
                        except ValueError:
                            continue
                        self.assertIn(est.key_of(p), cal.seeds)

    def test_self_calibration_moves_toward_measurements(self):
        cal = est.Calibration()
        key = "t2v|video-quality|720p|lightning"
        cal.record(key, 50.0)
        rate, basis, samples = cal.rate(key)
        self.assertEqual((rate, basis, samples), (30.0, "measured", 1))  # median(50, 30, 30)
        cal.record(key, 50.0)
        self.assertEqual(cal.rate(key)[0], 50.0)  # median(50, 50, 30)
        for _ in range(20):
            cal.record(key, 20.0)
        self.assertEqual(cal.rate(key)[0], 20.0)
        self.assertEqual(len(cal.samples[key]), est.MAX_SAMPLES)

    def test_bad_samples_are_ignored_and_load_is_tracked(self):
        cal = est.Calibration()
        cal.record("k", -1)
        cal.record("k", 1e9)
        self.assertNotIn("k", cal.samples)
        for value in (90, 100, 110):
            cal.record("k", 10, load_seconds=value)
        self.assertEqual(cal.load_seconds(), 100)

    def test_persistence_round_trip(self):
        cal = est.Calibration()
        cal.record("t2v|video-quality|720p|lightning", 33.3, load_seconds=12)
        restored = est.Calibration()
        est.load_from(lambda: cal.to_json(), restored)
        self.assertEqual(restored.samples, cal.samples)
        self.assertEqual(restored.load_samples, [12.0])
        est.load_from(lambda: (_ for _ in ()).throw(RuntimeError("minio down")), restored)  # never fatal


class EstimateEndpointTests(unittest.TestCase):
    def setUp(self):
        main.calibration = est.Calibration()

    def test_valid_request(self):
        result = asyncio.run(main.estimate_video(main.EstimateRequest(resolution="720p", variants=2)))
        self.assertTrue(result["valid"])
        self.assertEqual(result["pipeline"], "t2v")
        self.assertEqual(result["seconds"], 40 + 2 * 150)
        self.assertEqual(result["claimSeconds"], round(est.CLAIM_SECONDS))

    def test_draft_cannot_take_video_or_1080p(self):
        video = asyncio.run(main.estimate_video(main.EstimateRequest(model="video-fast", hasVideo=True, mode="restyle")))
        self.assertFalse(video["valid"])
        self.assertIn("cannot use a source video", video["error"])
        big = asyncio.run(main.estimate_video(main.EstimateRequest(model="video-fast", resolution="1080p")))
        self.assertIn("up to 720p", big["error"])

    def test_video_input_defaults_to_full_schedule(self):
        result = asyncio.run(main.estimate_video(main.EstimateRequest(hasVideo=True, mode="restyle", resolution="480p")))
        self.assertFalse(result["accelerated"])
        self.assertEqual(result["key"], "vace|video-quality|480p|full")


class QueueEstimateTests(unittest.TestCase):
    def setUp(self):
        main.calibration = est.Calibration()

    def tearDown(self):
        main.jobs.clear()
        main.active_job_id = None
        while not main.queue.empty():
            main.queue.get_nowait()

    def test_job_estimate_matches_the_estimator(self):
        self.assertEqual(main.estimate_job_seconds(video_job("a")), 240)
        self.assertEqual(main.estimate_job_seconds(video_job("b", variants=2)), 440)

    def test_position_and_eta(self):
        running = video_job("run", owner="other", status="running")
        running.startedAt = (datetime.now(UTC) - timedelta(seconds=60)).isoformat()
        main.active_job_id = running.id
        for job in (video_job("q1", owner="other"), video_job("q2", variants=2)):
            main.queue.put_nowait(job.id)
        info = asyncio.run(main.video_queue(jobId="q2", x_burtson_owner="tester"))
        self.assertEqual((info["depth"], info["position"]), (2, 2))
        self.assertAlmostEqual(info["aheadSeconds"], 180 + 240, delta=2)
        self.assertAlmostEqual(info["etaSeconds"], 180 + 240 + 440, delta=2)
        overview = asyncio.run(main.video_queue(x_burtson_owner="anyone"))
        self.assertNotIn("position", overview)

    def test_waiting_for_gpu_adds_claim_and_running_never_hits_zero(self):
        job = video_job("run", status="running")
        job.startedAt = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        main.active_job_id = job.id
        self.assertEqual(asyncio.run(main.video_queue(jobId="run", x_burtson_owner="tester"))["etaSeconds"], 15)
        job.progress = {"stage": "waiting_for_gpu"}
        self.assertEqual(main.remaining_seconds(job), 240 + est.CLAIM_SECONDS)

    def test_health_counts_active_jobs_but_not_cancelled(self):
        gone = video_job("gone")
        gone.cancelRequested = True
        main.queue.put_nowait(gone.id)
        main.queue.put_nowait(video_job("live").id)
        main.active_job_id = video_job("run", status="running").id
        health = asyncio.run(main.ready())
        self.assertEqual((health["active"], health["activeJobs"]), (True, 2))

    def test_other_users_job_is_forbidden(self):
        video_job("theirs", owner="someone-else")
        with self.assertRaises(main.HTTPException) as caught:
            asyncio.run(main.video_queue(jobId="theirs", x_burtson_owner="tester"))
        self.assertEqual(caught.exception.status_code, 403)


class CancelAllTests(unittest.TestCase):
    def tearDown(self):
        main.jobs.clear()
        main.active_job_id = None

    def test_cancels_running_and_queued_only(self):
        video_job("q")
        video_job("done", status="completed")
        main.active_job_id = video_job("r", status="running").id
        real = httpx.AsyncClient
        with mock.patch.object(main.httpx, "AsyncClient", lambda **kw: real(
                transport=httpx.MockTransport(lambda r: httpx.Response(200)), base_url="http://w")):
            result = asyncio.run(main.cancel_all_jobs())
        self.assertEqual(result, {"cancelled": 2})
        self.assertTrue(main.jobs["q"].cancelRequested and main.jobs["r"].cancelRequested)
        self.assertFalse(main.jobs["done"].cancelRequested)


class WorkerWaitTests(unittest.TestCase):
    def tearDown(self):
        main.jobs.clear()

    def run_wait(self, handler, job, timeout=600):
        async def no_sleep(_s):
            return None

        async def go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://w") as client:
                return await main.wait_for_worker(client, job)

        with mock.patch.object(main.asyncio, "sleep", no_sleep), mock.patch.object(main, "WORKER_WAIT_SECONDS", timeout):
            return asyncio.run(go())

    def test_waits_until_the_worker_answers(self):
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return httpx.Response(200 if calls["n"] >= 3 else 503)

        job = video_job("w")
        self.assertTrue(self.run_wait(handler, job))
        self.assertEqual(job.progress["stage"], "waiting_for_gpu")
        self.assertEqual(calls["n"], 3)

    def test_cancel_while_waiting(self):
        job = video_job("c")
        job.cancelRequested = True
        self.assertFalse(self.run_wait(lambda r: httpx.Response(503), job))
        self.assertEqual(job.status, "cancelled")

    def test_gives_up_after_the_deadline(self):
        job = video_job("t")
        clock = iter([0.0, 10_000.0, 10_000.0, 10_000.0])
        fake_time = mock.Mock(monotonic=lambda: next(clock))
        with mock.patch.object(main, "time", fake_time):
            with self.assertRaises(RuntimeError):
                self.run_wait(lambda r: httpx.Response(503), job, timeout=60)


if __name__ == "__main__":
    unittest.main()
