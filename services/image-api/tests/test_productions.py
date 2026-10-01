"""Productions: night window, durable queue (lease/retry/recovery), gpu-intent and routes.

Mongo is mongomock; the clock is injected; the image-api executor is a fake.
"""
import asyncio
import unittest
from datetime import UTC, datetime, timedelta

import mongomock
from fastapi.testclient import TestClient

from app import main
from app.productions import dispatcher as dsp
from app.productions import routes, schedule
from app.productions.store import PRIORITY_REDO, Store, classify_error, derive_status, job_id_for

CHICAGO_2300 = datetime(2026, 10, 1, 4, 0, tzinfo=UTC)   # Wed 30 Sep 23:00 CDT
CHICAGO_NOON = datetime(2026, 9, 30, 17, 0, tzinfo=UTC)  # Wed 30 Sep 12:00 CDT


def fake_estimator(request: dict) -> dict:
    if request["model"] == "video-fast" and request["resolution"] == "1080p":
        raise ValueError("Draft does not render 1080p")
    per_take = {"480p": 80, "720p": 170, "1080p": 210}[request["resolution"]]
    kind = "i2v" if request.get("keyframe") else "t2v"
    return {"key": f"{kind}|{request['model']}|{request['resolution']}|lightning", "perTakeSeconds": per_take,
            "loadSeconds": 40}


class Clock:
    def __init__(self, now: datetime):
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta) -> None:
        self.now += timedelta(**delta)


class FakeExecutor:
    def __init__(self):
        self.busy = False
        self.ready = True
        self.jobs: dict[str, dict] = {}
        self.submitted: list[dict] = []
        self.cancelled: list[str] = []
        self.fail_submit: dsp.SubmitError | None = None

    def interactive_busy(self):
        return self.busy

    def worker_ready(self):
        return self.ready

    def submit(self, job):
        if self.fail_submit:
            raise self.fail_submit
        image_id = f"img{len(self.submitted) + 1}"
        self.submitted.append(job)
        self.jobs[image_id] = {"status": "queued", "error": None, "startedAt": None, "updatedAt": None,
                               "videos": [], "progress": {}}
        return image_id

    def status(self, image_job_id):
        return self.jobs.get(image_job_id)

    def cancel(self, image_job_id):
        self.cancelled.append(image_job_id)

    def take_fields(self, job, image_job):
        return {"prefix": f"v1/productions/o/{job['productionId']}/takes/{job['_id']}",
                "files": {"video": "video-01.mp4", "poster": "poster-01.jpg"}, "width": 1280, "height": 720}

    # test helpers
    def run(self, image_id, started):
        self.jobs[image_id].update(status="running", startedAt=started.isoformat())

    def finish(self, image_id, finished, *, error=None):
        job = self.jobs[image_id]
        job["updatedAt"] = finished.isoformat()
        if error:
            job.update(status="failed", error=error)
        else:
            job.update(status="completed", videos=[{"variant": 1}])


def make(now=CHICAGO_2300, **settings):
    clock = Clock(now)
    store = Store(mongomock.MongoClient().db, estimator=fake_estimator, clock=clock)
    store.ensure_indexes()
    if settings:
        store.update_settings(settings)
    executor = FakeExecutor()
    dispatcher = dsp.Dispatcher(store, executor, holder="pod-a:1", clock=clock, load_seconds=lambda: 40)
    return clock, store, executor, dispatcher


def seed_production(store, owner="owner-1", shots=2, takes=2):
    production = store.create_production(owner, {"title": "Test film", "defaults": {"takes": takes}})
    episode = store.create_episode(owner, production["id"], {"title": "Pilot"})
    scene = store.create_scene(owner, production["id"], {"episodeId": episode["id"], "title": "Harbour"})
    created = store.create_shots(owner, production["id"], scene["id"],
                                 [{"prompt": f"a lighthouse at dusk, shot {n}"} for n in range(shots)])
    return production, episode, scene, created


class ScheduleTests(unittest.TestCase):
    def test_overnight_window_open_and_closed(self):
        settings = dict(schedule.DEFAULT_SETTINGS)
        window = schedule.window_at(CHICAGO_2300, settings)
        self.assertTrue(window.open)
        self.assertEqual(window.start, datetime(2026, 10, 1, 3, 0, tzinfo=UTC))
        self.assertEqual(window.end, datetime(2026, 10, 1, 12, 0, tzinfo=UTC))
        self.assertEqual(window.night_id, "2026-09-30")
        noon = schedule.window_at(CHICAGO_NOON, settings)
        self.assertFalse(noon.open)
        self.assertEqual(noon.start, datetime(2026, 10, 1, 3, 0, tzinfo=UTC))

    def test_after_midnight_belongs_to_the_previous_evening(self):
        two_am = datetime(2026, 10, 1, 7, 0, tzinfo=UTC)  # 02:00 CDT Thursday
        window = schedule.window_at(two_am, dict(schedule.DEFAULT_SETTINGS))
        self.assertTrue(window.open)
        self.assertEqual(window.night_id, "2026-09-30")

    def test_days_filter_skips_a_night(self):
        settings = {**schedule.DEFAULT_SETTINGS, "days": [0, 1, 3, 4, 5, 6]}  # no Wednesday
        window = schedule.window_at(CHICAGO_2300, settings)
        self.assertFalse(window.open)
        self.assertEqual(window.night_id, "2026-10-01")

    def test_same_day_test_window(self):
        settings = {**schedule.DEFAULT_SETTINGS, "windowStart": "12:02", "windowEnd": "12:22"}
        self.assertFalse(schedule.window_at(CHICAGO_NOON, settings).open)
        inside = schedule.window_at(CHICAGO_NOON + timedelta(minutes=5), settings)
        self.assertTrue(inside.open)
        self.assertEqual(inside.length(), 20 * 60)

    def test_dst_end_night_is_ten_hours(self):
        night = datetime(2026, 11, 1, 4, 0, tzinfo=UTC)  # Sat 31 Oct 23:00 CDT; clocks fall back
        window = schedule.window_at(night, dict(schedule.DEFAULT_SETTINGS))
        self.assertEqual(window.length(), 10 * 3600)

    def test_validation(self):
        with self.assertRaises(ValueError):
            schedule.validate({"windowStart": "25:00"})
        with self.assertRaises(ValueError):
            schedule.validate({"timezone": "Mars/Base"})
        with self.assertRaises(ValueError):
            schedule.validate({"windowStart": "22:00", "windowEnd": "22:00"})

    def test_capacity_is_budget_capped(self):
        settings = dict(schedule.DEFAULT_SETTINGS)
        self.assertEqual(schedule.nightly_capacity_seconds(CHICAGO_NOON, settings), 480 * 60)
        self.assertEqual(schedule.nights_for(480 * 60 * 3, 480 * 60), 3.0)

    def test_session(self):
        session = {"startedAt": CHICAGO_NOON.isoformat(), "until": (CHICAGO_NOON + timedelta(minutes=30)).isoformat()}
        window = schedule.active_window(CHICAGO_NOON + timedelta(minutes=1), {**schedule.DEFAULT_SETTINGS,
                                                                              "session": session})
        self.assertEqual(window.kind, "session")
        self.assertIsNone(schedule.active_window(CHICAGO_NOON + timedelta(hours=1),
                                                 {**schedule.DEFAULT_SETTINGS, "session": session}))


class QueueTests(unittest.TestCase):
    def test_queue_is_idempotent_per_revision(self):
        _, store, _, _ = make()
        production, _, _, shots = seed_production(store, shots=1)
        pid, sid = production["id"], shots[0]["id"]
        self.assertEqual(store.queue_shot("owner-1", pid, sid)["queuedJobs"], 2)
        self.assertEqual(store.queue_shot("owner-1", pid, sid)["queuedJobs"], 0)
        self.assertEqual(store.queue_shot("owner-1", pid, sid, takes=3)["queuedJobs"], 1)
        ids = sorted(j["_id"] for j in store.db.jobs.find())
        self.assertEqual(ids, sorted(job_id_for(sid, 1, n) for n in range(3)))

    def test_edit_bumps_revision_and_cancels_old_queued_takes(self):
        _, store, _, _ = make()
        production, _, _, shots = seed_production(store, shots=1)
        pid, sid = production["id"], shots[0]["id"]
        store.queue_shot("owner-1", pid, sid)
        shot = store.update_shot("owner-1", pid, sid, {"prompt": "a lighthouse in fog"})
        self.assertEqual(shot["revision"], 2)
        self.assertEqual(store.db.jobs.count_documents({"status": "cancelled"}), 2)
        self.assertEqual(shot["status"], "draft")
        # A title change is not a render change.
        self.assertEqual(store.update_shot("owner-1", pid, sid, {"title": "Opening"})["revision"], 2)
        store.queue_shot("owner-1", pid, sid)
        self.assertEqual(store.db.jobs.count_documents({"status": "queued", "shotRevision": 2}), 2)

    def test_cancelled_take_comes_back_when_requeued(self):
        _, store, _, _ = make()
        production, _, _, shots = seed_production(store, shots=1)
        pid, sid = production["id"], shots[0]["id"]
        store.queue_shot("owner-1", pid, sid)
        self.assertEqual(store.cancel_shot("owner-1", pid, sid)["cancelled"], 2)
        self.assertEqual(store.queue_shot("owner-1", pid, sid)["queuedJobs"], 2)

    def test_queue_episode_skips_approved_shots(self):
        _, store, _, _ = make()
        production, episode, _, shots = seed_production(store, shots=3)
        store.db.shots.update_one({"_id": shots[0]["id"]}, {"$set": {"chosenTakeId": "tk_x"}})
        result = store.queue_episode("owner-1", production["id"], episode["id"])
        self.assertEqual(result, {"queuedJobs": 4, "shots": 2, "estimateSeconds": 4 * 170})

    def test_invalid_combination_is_refused(self):
        _, store, _, _ = make()
        production, _, scene, _ = seed_production(store, shots=1)
        with self.assertRaisesRegex(Exception, "1080p"):
            store.create_shot("owner-1", production["id"], {"sceneId": scene["id"], "prompt": "a test shot",
                                                            "model": "video-fast", "resolution": "1080p"})
        with self.assertRaisesRegex(Exception, "2 to 5"):
            store.create_shot("owner-1", production["id"], {"sceneId": scene["id"], "prompt": "too long",
                                                            "durationSeconds": 8})

    def test_1080p_is_an_explicit_opt_in(self):
        _, store, _, _ = make()
        production, _, scene, shots = seed_production(store, shots=1)
        pid, sid = production["id"], shots[0]["id"]
        self.assertEqual(production["defaults"]["resolution"], "720p")
        with self.assertRaisesRegex(Exception, "explicit opt-in"):
            store.update_shot("owner-1", pid, sid, {"resolution": "1080p"})
        with self.assertRaisesRegex(Exception, "explicit opt-in"):
            store.create_shot("owner-1", pid, {"sceneId": scene["id"], "prompt": "a pier", "resolution": "1080p"})
        with self.assertRaisesRegex(Exception, "explicit opt-in"):
            store.create_production("owner-1", {"title": "Big", "defaults": {"resolution": "1080p"}})
        shot = store.update_shot("owner-1", pid, sid, {"resolution": "1080p", "confirm1080p": True})
        self.assertEqual(shot["resolution"], "1080p")
        # Once confirmed, other edits do not ask again.
        self.assertEqual(store.update_shot("owner-1", pid, sid, {"prompt": "a pier at night"})["resolution"], "1080p")
        big = store.create_production("owner-1", {"title": "Big", "defaults": {"resolution": "1080p"},
                                                  "confirm1080p": True})
        episode = store.create_episode("owner-1", big["id"], {"title": "E1"})
        big_scene = store.create_scene("owner-1", big["id"], {"episodeId": episode["id"], "title": "S1"})
        inherited = store.create_shot("owner-1", big["id"], {"sceneId": big_scene["id"], "prompt": "a pier"})
        self.assertEqual(inherited["resolution"], "1080p")

    def test_other_owners_cannot_see_productions(self):
        _, store, _, _ = make()
        production, _, _, _ = seed_production(store)
        self.assertEqual(store.list_productions("someone-else"), [])
        with self.assertRaises(Exception):
            store.board("someone-else", production["id"])

    def test_regenerate_with_note_queues_a_new_revision_first(self):
        clock, store, executor, dispatcher = make()
        production, _, _, shots = seed_production(store, shots=2, takes=1)
        pid = production["id"]
        for shot in shots:
            store.queue_shot("owner-1", pid, shot["id"])
        self.assertEqual(dispatcher.tick(), "dispatched")
        executor.finish("img1", clock.now)
        dispatcher.tick()
        done = executor.submitted[0]
        shot = store.regenerate("owner-1", pid, done["shotId"], note="slower, less wind", keep_seed=True)
        self.assertEqual(shot["revision"], 2)
        self.assertEqual(shot["notes"][-1]["text"], "slower, less wind")
        redo = store.db.jobs.find_one({"shotId": done["shotId"], "shotRevision": 2})
        self.assertEqual(redo["priority"], PRIORITY_REDO)
        self.assertEqual(redo["seed"], done["seed"])
        self.assertEqual(redo["note"], "slower, less wind")
        self.assertEqual(dispatcher.tick(), "dispatched")
        self.assertEqual(executor.submitted[-1]["_id"], redo["_id"])  # ahead of the other shot

    def test_choose_and_reject(self):
        clock, store, executor, dispatcher = make()
        production, _, _, shots = seed_production(store, shots=1, takes=2)
        pid, sid = production["id"], shots[0]["id"]
        store.queue_shot("owner-1", pid, sid)
        for n in (1, 2):
            dispatcher.tick()
            executor.finish(f"img{n}", clock.now)
            dispatcher.tick()
        shot = store.shot_view("owner-1", pid, sid)
        self.assertEqual(shot["status"], "review")
        first, second = shot["takes"][1]["id"], shot["takes"][0]["id"]
        shot = store.choose_take("owner-1", pid, sid, first)
        self.assertEqual(shot["status"], "approved")
        self.assertEqual({t["id"]: t["status"] for t in shot["takes"]}, {first: "chosen", second: "alternate"})
        shot = store.reject_take("owner-1", pid, sid, first)
        self.assertEqual(shot["status"], "review")
        self.assertIsNone(shot["chosenTakeId"])

    def test_derive_status(self):
        shot = {"revision": 2, "chosenTakeId": None}
        self.assertEqual(derive_status(shot, [], []), "draft")
        self.assertEqual(derive_status(shot, [{"status": "queued"}], []), "queued")
        self.assertEqual(derive_status(shot, [{"status": "running"}, {"status": "queued"}], []), "rendering")
        self.assertEqual(derive_status(shot, [{"status": "dead", "shotRevision": 2}], []), "needs_attention")
        self.assertEqual(derive_status(shot, [], [{"status": "ready", "shotRevision": 1}]), "review")

    def test_error_classes(self):
        self.assertEqual(classify_error("CUDA out of memory. Tried to allocate"), "oom")
        self.assertEqual(classify_error("video variant exceeded 3600 s"), "timeout")
        self.assertEqual(classify_error("ComfyUI rejected the video workflow: x"), "invalid")
        self.assertEqual(classify_error("the GPU worker did not become ready within 600 s"), "transient")


class DispatcherTests(unittest.TestCase):
    def queued(self, **settings):
        clock, store, executor, dispatcher = make(**settings)
        production, episode, _, shots = seed_production(store, shots=2, takes=2)
        store.queue_episode("owner-1", production["id"], episode["id"])
        return clock, store, executor, dispatcher

    def test_outside_the_window_nothing_runs_and_no_claim(self):
        clock, store, executor, dispatcher = self.queued()
        clock.now = CHICAGO_NOON
        self.assertEqual(dispatcher.tick(), "outside-window")
        intent = dispatcher.intent()
        self.assertFalse(intent["wantGpu"])
        self.assertEqual(executor.submitted, [])
        tonight = dispatcher.tonight()
        self.assertEqual(tonight["queuedTakes"], 4)
        self.assertEqual(tonight["fitTakes"], 4)
        self.assertEqual(tonight["claimsAt"], "2026-10-01T03:00:00+00:00")

    def test_empty_queue_never_claims(self):
        clock, store, executor, dispatcher = make()
        seed_production(store)
        intent = dispatcher.intent()
        self.assertFalse(intent["wantGpu"])
        self.assertTrue(intent["releaseWhenDone"])
        self.assertEqual(intent["reason"], "Nothing is queued")
        self.assertEqual(dispatcher.tick(), "queue-empty")
        self.assertIsNone(dispatcher.tonight()["claimsAt"])

    def test_night_runs_every_take_then_releases(self):
        clock, store, executor, dispatcher = self.queued()
        self.assertTrue(dispatcher.intent()["wantGpu"])
        for n in range(1, 5):
            self.assertEqual(dispatcher.tick(), "dispatched")
            self.assertTrue(dispatcher.intent()["wantGpu"])
            self.assertEqual(dispatcher.tick(), "watching")
            executor.run(f"img{n}", clock.now)
            clock.advance(seconds=180)
            executor.finish(f"img{n}", clock.now)
            self.assertEqual(dispatcher.tick(), "completed")
        intent = dispatcher.intent()
        self.assertFalse(intent["wantGpu"])
        self.assertTrue(intent["releaseWhenDone"])
        self.assertEqual(store.db.takes.count_documents({}), 4)
        night = store.night(schedule.window_at(clock.now, store.settings()))
        self.assertEqual(night["takesCompleted"], 4)
        self.assertEqual(night["gpuSeconds"], 720)
        statuses = {s["status"] for s in store.board("owner-1", store.db.productions.find_one()["_id"])["shots"]}
        self.assertEqual(statuses, {"review"})

    def test_interactive_jobs_go_first(self):
        clock, store, executor, dispatcher = self.queued()
        executor.busy = True
        self.assertEqual(dispatcher.tick(), "interactive-first")
        self.assertTrue(dispatcher.intent()["wantGpu"])  # still wants the card, just waits its turn
        executor.busy = False
        self.assertEqual(dispatcher.tick(), "dispatched")

    def test_waits_for_the_worker(self):
        clock, store, executor, dispatcher = self.queued()
        executor.ready = False
        self.assertEqual(dispatcher.tick(), "waiting-for-gpu")
        self.assertEqual(store.db.jobs.count_documents({"status": "queued"}), 4)

    def test_never_starts_a_take_that_would_cross_the_window_end(self):
        clock, store, executor, dispatcher = self.queued(graceMinutes=0)
        end = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)  # 07:00 local
        clock.now = end - timedelta(seconds=209)  # 170 s take + 40 s load = 210 s
        intent = dispatcher.intent()
        self.assertFalse(intent["wantGpu"])
        self.assertIn("before the window ends", intent["reason"])
        self.assertEqual(dispatcher.tick(), "nothing-fits")
        clock.now = end - timedelta(seconds=211)
        self.assertEqual(dispatcher.tick(), "dispatched")

    def test_grace_lets_the_last_take_run_slightly_over(self):
        clock, store, executor, dispatcher = self.queued(graceMinutes=10)
        clock.now = datetime(2026, 10, 1, 12, 0, tzinfo=UTC) - timedelta(seconds=60)
        self.assertEqual(dispatcher.tick(), "dispatched")

    def test_running_take_finishes_past_the_window_then_release(self):
        clock, store, executor, dispatcher = self.queued()
        clock.now = datetime(2026, 10, 1, 11, 56, tzinfo=UTC)  # 06:56 local
        self.assertEqual(dispatcher.tick(), "dispatched")
        clock.now = datetime(2026, 10, 1, 12, 2, tzinfo=UTC)  # 07:02, window closed
        intent = dispatcher.intent()
        self.assertTrue(intent["wantGpu"])
        self.assertFalse(intent["releaseWhenDone"])
        executor.finish("img1", clock.now)
        self.assertEqual(dispatcher.tick(), "completed")
        intent = dispatcher.intent()
        self.assertFalse(intent["wantGpu"])
        self.assertTrue(intent["releaseWhenDone"])
        self.assertEqual(dispatcher.tick(), "outside-window")
        self.assertEqual(store.db.jobs.count_documents({"status": "queued"}), 3)  # carry over to tomorrow

    def test_budget_stops_dispatch(self):
        clock, store, executor, dispatcher = self.queued(budgetMinutes=10)
        for n in range(1, 4):
            if dispatcher.tick() != "dispatched":
                break
            clock.advance(seconds=200)
            executor.finish(f"img{n}", clock.now)
            executor.jobs[f"img{n}"]["startedAt"] = (clock.now - timedelta(seconds=200)).isoformat()
            dispatcher.tick()
        intent = dispatcher.intent()
        self.assertFalse(intent["wantGpu"])
        self.assertIn("budget", intent["reason"])
        self.assertEqual(store.db.takes.count_documents({}), 3)  # 3 x 200 s = the 600 s budget

    def test_restart_recovers_a_lost_take_without_counting_it(self):
        clock, store, executor, dispatcher = self.queued()
        dispatcher.tick()
        job = store.in_flight()[0]
        restarted = dsp.Dispatcher(store, FakeExecutor(), holder="pod-a:2", clock=clock)
        self.assertEqual(restarted.tick(), "recovered-lost")
        again = store.db.jobs.find_one({"_id": job["_id"]})
        self.assertEqual(again["status"], "queued")
        self.assertEqual(again["attempts"], 0)
        self.assertEqual(again["errorClass"], "lost")
        self.assertEqual(restarted.tick(), "dispatched")

    def test_lease_held_by_a_dead_process_is_recovered(self):
        clock, store, executor, dispatcher = self.queued()
        job = store.candidates(clock.now)[0]
        store.lease(job["_id"], "old-pod:9", 600)
        self.assertEqual(dispatcher.tick(), "recovered-lost")
        self.assertEqual(store.db.jobs.find_one({"_id": job["_id"]})["status"], "queued")

    def test_lease_is_exclusive(self):
        clock, store, executor, dispatcher = self.queued()
        job = store.candidates(clock.now)[0]
        self.assertIsNotNone(store.lease(job["_id"], "a", 600))
        self.assertIsNone(store.lease(job["_id"], "b", 600))

    def test_transient_failures_back_off_then_die(self):
        clock, store, executor, dispatcher = self.queued()
        first = store.candidates(clock.now)[0]["_id"]
        for attempt in range(1, 6):
            store.db.jobs.update_many({"_id": {"$ne": first}}, {"$set": {"status": "cancelled"}})
            self.assertEqual(dispatcher.tick(), "dispatched", attempt)
            executor.finish(f"img{attempt}", clock.now, error="the GPU worker did not become ready within 600 s")
            dispatcher.tick()
            job = store.db.jobs.find_one({"_id": first})
            if attempt < 5:
                self.assertEqual(job["status"], "queued")
                self.assertIsNotNone(job["notBefore"])
                self.assertEqual(dispatcher.tick(), "queue-empty")  # backing off
                clock.now = datetime.fromisoformat(job["notBefore"])
        self.assertEqual(job["status"], "dead")
        shot = store.shot_view("owner-1", job["productionId"], job["shotId"])
        self.assertEqual(shot["status"], "needs_attention")
        store.retry_job("owner-1", job["productionId"], first)
        self.assertEqual(store.db.jobs.find_one({"_id": first})["status"], "queued")

    def test_invalid_is_dead_at_once_and_oom_retries_once(self):
        clock, store, executor, dispatcher = self.queued()
        dispatcher.tick()
        executor.finish("img1", clock.now, error="ComfyUI rejected the video workflow: bad node")
        dispatcher.tick()
        self.assertEqual(store.db.jobs.count_documents({"status": "dead"}), 1)
        dispatcher.tick()
        executor.finish("img2", clock.now, error="CUDA out of memory")
        dispatcher.tick()
        oom = store.db.jobs.find_one({"errorClass": "oom"})
        self.assertEqual(oom["status"], "queued")
        self.assertIsNone(oom["notBefore"])

    def test_submit_errors_are_classified(self):
        clock, store, executor, dispatcher = self.queued()
        executor.fail_submit = dsp.SubmitError("invalid", "the shot's frame keyframe-start-x.png is missing")
        self.assertEqual(dispatcher.tick(), "submit-failed")
        self.assertEqual(store.db.jobs.count_documents({"status": "dead"}), 1)

    def test_stalled_take_is_cancelled(self):
        clock, store, executor, dispatcher = self.queued()
        dispatcher.tick()
        executor.run("img1", clock.now)
        clock.advance(seconds=170 + 40 + 901)
        self.assertEqual(dispatcher.tick(), "stalled")
        self.assertEqual(executor.cancelled, ["img1"])
        self.assertEqual(store.db.jobs.find_one({"errorClass": "timeout"})["status"], "queued")

    def test_forced_release_requeues_the_take(self):
        clock, store, executor, dispatcher = self.queued()
        dispatcher.tick()
        executor.jobs["img1"]["status"] = "cancelled"
        self.assertEqual(dispatcher.tick(), "requeued-cancelled")
        job = store.db.jobs.find_one({"errorClass": "released"})
        self.assertEqual((job["status"], job["attempts"]), ("queued", 0))

    def test_pause_and_gpu_fault(self):
        clock, store, executor, dispatcher = self.queued()
        store.pause("holiday")
        self.assertEqual(dispatcher.tick(), "paused")
        self.assertFalse(dispatcher.intent()["wantGpu"])
        store.resume()
        store.record_health(healthy=False, fault="Xid 79: GPU has fallen off the bus", temperature_c=71)
        settings = store.settings()
        self.assertTrue(settings["paused"])
        self.assertIn("Xid 79", settings["pausedReason"])
        self.assertEqual(dispatcher.tick(), "paused")
        self.assertEqual(store.db.gpu_events.count_documents({}), 1)
        store.resume()
        store.record_health(healthy=False, reason="88 C", temperature_c=88)
        self.assertFalse(store.settings()["paused"])  # heat holds dispatch but does not pause
        self.assertEqual(dispatcher.tick(), "gpu-unhealthy")
        store.record_health(healthy=True, temperature_c=70)
        self.assertEqual(dispatcher.tick(), "dispatched")

    def test_paused_production_is_skipped(self):
        clock, store, executor, dispatcher = self.queued()
        production = store.db.productions.find_one()
        store.update_production("owner-1", production["_id"], {"paused": True})
        self.assertEqual(dispatcher.tick(), "queue-empty")
        store.update_production("owner-1", production["_id"], {"paused": False})
        self.assertEqual(dispatcher.tick(), "dispatched")

    def test_manual_session_runs_in_the_day(self):
        clock, store, executor, dispatcher = self.queued()
        clock.now = CHICAGO_NOON
        self.assertEqual(dispatcher.tick(), "outside-window")
        store.start_session(30)
        self.assertTrue(dispatcher.intent()["wantGpu"])
        self.assertEqual(dispatcher.tick(), "dispatched")

    def test_status_shape(self):
        clock, store, executor, dispatcher = self.queued()
        status = dispatcher.status()
        self.assertTrue(status["window"]["open"])
        self.assertEqual(status["tonight"]["queuedTakes"], 4)
        self.assertEqual(status["tonight"]["estimatedSeconds"], 40 + 4 * 170)
        self.assertIsNone(status["inFlight"])
        dispatcher.tick()
        self.assertEqual(dispatcher.status()["inFlight"]["takeId"], store.in_flight()[0]["_id"])


class ImageApiIntegrationTests(unittest.TestCase):
    def tearDown(self):
        main.jobs.clear()
        main.idempotency.clear()
        while not main.queue.empty():
            main.queue.get_nowait()

    def test_idempotency_key_returns_the_same_job(self):
        request = main.VideoRequest(prompt="a lighthouse at dusk", seed=5)
        first = main.create_video_job(request, "owner", idempotency_key="tk_1:1")
        again = main.create_video_job(request, "owner", idempotency_key="tk_1:1")
        self.assertIs(first, again)
        self.assertEqual(main.queue.qsize(), 1)
        other = main.create_video_job(request, "owner", idempotency_key="tk_1:2")
        self.assertNotEqual(first.id, other.id)

    def test_production_outputs_skip_ttl_and_history(self):
        origin = {"kind": "production", "productionId": "pr_1", "shotId": "sh_1", "takeId": "tk_abc"}
        job = main.create_video_job(main.VideoRequest(prompt="a lighthouse at dusk"), "owner@x", origin=origin)
        self.assertEqual(main.output_prefix(job, datetime.now(UTC)), "v1/productions/owner-x/pr_1/takes/tk_abc")
        self.assertTrue(main.is_production(job.request))
        plain = main.create_video_job(main.VideoRequest(prompt="a lighthouse at dusk"), "owner@x")
        self.assertTrue(main.output_prefix(plain, datetime.now(UTC)).startswith("v1/tenant/"))
        job.status = "completed"
        recorded = []
        original = main.library.record
        main.library.record = lambda *a, **k: recorded.append(a)
        try:
            asyncio.run(main.record_in_library(job))
        finally:
            main.library.record = original
        self.assertEqual(recorded, [])

    def test_estimate_take_matches_the_estimator(self):
        result = main.estimate_take({"model": "video-quality", "resolution": "720p", "durationSeconds": 5,
                                     "aspect": "16:9", "camera": "static", "keyframe": "keyframe-start-a.png"})
        self.assertTrue(result["key"].startswith("i2v|video-quality|720p|lightning"))
        with self.assertRaises(ValueError):
            main.estimate_take({"model": "video-fast", "resolution": "1080p", "durationSeconds": 5})


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.store, self.executor, self.dispatcher = make(now=CHICAGO_NOON)
        self.objects: dict[str, tuple[bytes, str]] = {}
        routes.runtime = routes.Runtime(
            store=self.store, dispatcher=self.dispatcher, get_object=self.objects.get,
            put_object=lambda key, body, ct: self.objects.__setitem__(key, (body, ct)),
            normalize_image=lambda body: (body, 640, 360), safe_owner=main.safe_owner, max_upload_bytes=1024 * 1024)
        self.client = TestClient(main.app)
        self.headers = {"X-Burtson-Owner": "admin-1"}

    def tearDown(self):
        routes.runtime = None

    def test_flow(self):
        c, h = self.client, self.headers
        production = c.post("/api/productions", json={"title": "Harbour"}, headers=h).json()
        pid = production["id"]
        self.assertEqual(production["defaults"]["takes"], 2)
        episode = c.post(f"/api/productions/{pid}/episodes", json={"title": "One"}, headers=h).json()
        scene = c.post(f"/api/productions/{pid}/scenes", json={"episodeId": episode["id"], "title": "Dock"},
                       headers=h).json()
        bulk = c.post(f"/api/productions/{pid}/shots/bulk", json={
            "sceneId": scene["id"], "shots": [{"prompt": "waves on a pier"}, {"prompt": "gulls over water"}]},
            headers=h)
        self.assertEqual(bulk.status_code, 201, bulk.text)
        shot = bulk.json()["shots"][0]
        upload = c.post(f"/api/productions/{pid}/shots/{shot['id']}/keyframe", files={"file": ("k.png", b"png")},
                        data={"role": "start"}, headers=h)
        self.assertEqual(upload.status_code, 200, upload.text)
        frame = upload.json()["keyframe"]
        self.assertRegex(frame["name"], r"^keyframe-start-[0-9a-f]{12}\.png$")
        self.assertEqual(upload.json()["revision"], 2)
        got = c.get(f"/api/productions/{pid}/shots/{shot['id']}/files/{frame['name']}", headers=h)
        self.assertEqual(got.content, b"png")
        queued = c.post(f"/api/productions/{pid}/episodes/{episode['id']}/queue", json={}, headers=h).json()
        self.assertEqual(queued["queuedJobs"], 4)
        board = c.get(f"/api/productions/{pid}", headers=h).json()
        self.assertEqual({s["status"] for s in board["shots"]}, {"queued"})
        self.assertGreater(board["eta"]["remainingSeconds"], 0)
        status = c.get("/api/productions/status").json()
        self.assertEqual(status["tonight"]["queuedTakes"], 4)
        self.assertFalse(status["intent"]["wantGpu"])  # noon: outside the window
        listing = c.get("/api/productions", headers=h).json()["productions"]
        self.assertEqual(listing[0]["summary"]["queuedTakes"], 4)
        self.assertEqual(c.get(f"/api/productions/{pid}", headers={"X-Burtson-Owner": "other"}).status_code, 404)

    def test_settings_and_intent_health(self):
        c = self.client
        settings = c.put("/api/productions/settings", json={"windowStart": "21:30", "budgetMinutes": 300}).json()
        self.assertEqual((settings["windowStart"], settings["budgetMinutes"]), ("21:30", 300))
        self.assertEqual(c.put("/api/productions/settings", json={"windowStart": "9pm"}).status_code, 400)
        intent = c.get("/api/productions/gpu-intent", params={"healthy": "false", "fault": "Xid 79",
                                                              "temperatureC": 70}).json()
        self.assertFalse(intent["wantGpu"])
        self.assertTrue(c.get("/api/productions/settings").json()["paused"])
        self.assertFalse(c.post("/api/productions/resume").json()["paused"])

    def test_unconfigured_is_503(self):
        routes.runtime = None
        self.assertEqual(self.client.get("/api/productions/status").status_code, 503)


if __name__ == "__main__":
    unittest.main()
