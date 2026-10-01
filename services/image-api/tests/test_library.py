import asyncio
import io
import json
import unittest
from datetime import UTC, datetime, timedelta
from unittest import mock

from fastapi import HTTPException
from PIL import Image

from app import library as lib
from app import main

OWNER = "user-123"
DAY = "v1/tenant/user-123/2026/09/30"


def jpeg(color=(200, 10, 10), size=(1280, 720)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="JPEG")
    return output.getvalue()


def png(size=(1024, 1024)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, (10, 10, 200)).save(output, format="PNG")
    return output.getvalue()


class FakeStore:
    def __init__(self):
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.modified: dict[str, datetime] = {}
        self.fail_copy: set[str] = set()

    def get(self, key):
        found = self.objects.get(key)
        return found[0] if found else None

    def put(self, key, body, content_type):
        self.objects[key] = (body, content_type)
        self.modified[key] = datetime.now(UTC)

    def copy(self, source, target, content_type):
        if source in self.fail_copy:
            raise RuntimeError("copy failed")
        if source not in self.objects:
            return False
        self.put(target, self.objects[source][0], content_type)
        return True

    def list(self, prefix):
        for key in sorted(self.objects):
            if key.startswith(prefix):
                yield key, self.modified.get(key)


def video_metadata(job_id="job0001video", takes=2, owner=OWNER, **request):
    return {
        "jobId": job_id, "owner": owner, "createdAt": "2026-09-30T22:30:00+00:00", "kind": "video",
        "request": {"prompt": "truck at dusk", "model": "video-quality", "seed": 42, "variants": takes,
                    "referenceId": "ref00000start", "plan": {"big": "plan"}, **request},
        "videos": [{"url": f"/image/jobs/{job_id}/assets/{2 * n}", "posterUrl": "x", "variant": n + 1,
                    "seed": 42 + n * 1000, "model": "wan22-i2v-a14b", "width": 1280, "height": 720, "fps": 24,
                    "durationSeconds": 5.0, "bytes": 3, "mode": "image-to-video"} for n in range(takes)],
        "error": None,
    }


def seed_video(store, job_id="job0001video", takes=2, day=DAY):
    for n in range(1, takes + 1):
        store.put(f"{day}/{job_id}/video-{n:02d}.mp4", b"mp4", "video/mp4")
        store.put(f"{day}/{job_id}/poster-{n:02d}.jpg", jpeg(), "image/jpeg")
    store.put(f"{day}/references/ref00000start.png", png(), "image/png")


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.library = lib.Library(self.store)

    def test_video_job_is_copied_with_thumbs_and_inputs(self):
        seed_video(self.store)
        item = self.library.record(video_metadata(), tenant_dir=f"{DAY}/job0001video",
                                   input_keys={"ref00000start": f"{DAY}/references/ref00000start.png"},
                                   started_at="2026-09-30T22:30:10+00:00",
                                   completed_at="2026-09-30T22:34:10+00:00")
        base = "v1/library/user-123/items/job0001video"
        for name in ("video-01.mp4", "poster-01.jpg", "thumb-01.jpg", "video-02.mp4", "input-reference.png",
                     "metadata.json"):
            self.assertIn(f"{base}/{name}", self.store.objects, name)
        with Image.open(io.BytesIO(self.store.get(f"{base}/thumb-01.jpg"))) as thumb:
            self.assertLessEqual(max(thumb.size), 640)
        self.assertNotIn("owner", item)
        self.assertNotIn("assetFiles", item)
        self.assertNotIn("plan", item["request"])
        self.assertEqual(item["inputs"], {"reference": "input-reference.png"})
        self.assertEqual([o["seed"] for o in item["outputs"]], [42, 1042])
        self.assertEqual([o["seedText"] for o in item["outputs"]], ["42", "1042"])
        self.assertEqual(item["seedText"], "42")
        self.assertEqual(item["elapsedSeconds"], 240.0)
        self.assertEqual(item["mode"], "image-to-video")
        self.assertFalse(item["favorite"])
        stored = json.loads(self.store.get(f"{base}/item.json"))
        self.assertEqual(stored["owner"], OWNER)

    def test_failed_job_is_indexed_without_files(self):
        meta = video_metadata(job_id="job0002failed", takes=0)
        meta["error"] = "ComfyUI failed"
        item = self.library.record(meta, status="failed")
        self.assertEqual(item["status"], "failed")
        self.assertEqual(item["outputs"], [])
        files = [key for key in self.store.objects if "job0002failed" in key]
        self.assertEqual(files, ["v1/library/user-123/items/job0002failed/item.json"])

    def test_rerecording_keeps_user_state(self):
        seed_video(self.store)
        self.library.record(video_metadata(), tenant_dir=f"{DAY}/job0001video")
        project = self.library.create_project(OWNER, "Trucks")
        self.library.update_item(OWNER, "job0001video", {
            "favorite": True, "projectId": project["id"], "outputs": [{"index": 1, "hidden": True}]})
        item = self.library.record(video_metadata(), tenant_dir=f"{DAY}/job0001video")
        self.assertTrue(item["favorite"])
        self.assertEqual(item["projectId"], project["id"])
        self.assertTrue(item["outputs"][1]["hidden"])
        self.assertFalse(item["outputs"][0]["hidden"])

    def test_image_job_uses_the_recorded_key(self):
        self.store.put(f"{DAY}/job0003image/image-01.png", png(), "image/png")
        meta = {"jobId": "job0003image", "owner": OWNER, "createdAt": "2026-09-30T21:00:00+00:00",
                "request": {"prompt": "logo", "model": "flux-schnell", "seed": 9},
                "images": [{"key": f"{DAY}/job0003image/image-01.png", "width": 1024, "height": 1024, "seed": 9,
                            "model": "flux-schnell", "mode": "generate"}]}
        item = self.library.record(meta)
        self.assertEqual(item["kind"], "image")
        self.assertEqual(item["outputs"][0]["file"], "image-01.png")
        self.assertEqual(item["outputs"][0]["thumb"], "thumb-01.jpg")
        self.assertEqual(self.library.legacy_asset(OWNER, "job0003image", 0)[1], "image/png")

    def test_missing_take_is_skipped(self):
        seed_video(self.store, takes=1)
        item = self.library.record(video_metadata(takes=2), tenant_dir=f"{DAY}/job0001video")
        self.assertEqual(len(item["outputs"]), 1)


class BackfillTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.library = lib.Library(self.store)

    def test_backfill_records_existing_jobs_once(self):
        seed_video(self.store)
        self.store.put(f"{DAY}/job0001video/metadata.json", json.dumps(video_metadata()).encode(), "application/json")
        self.assertEqual(self.library.backfill(), [])
        listing = self.library.list(OWNER)
        self.assertEqual([item["id"] for item in listing["items"]], ["job0001video"])
        self.assertEqual(listing["items"][0]["inputs"], {"reference": "input-reference.png"})
        self.library.update_item(OWNER, "job0001video", {"favorite": True})
        self.library.backfill()
        self.assertTrue(self.library.list(OWNER)["items"][0]["favorite"])

    def test_failed_copy_is_reported_so_the_reaper_keeps_it(self):
        seed_video(self.store)
        self.store.put(f"{DAY}/job0001video/metadata.json", json.dumps(video_metadata()).encode(), "application/json")
        self.store.fail_copy.add(f"{DAY}/job0001video/video-01.mp4")
        self.assertEqual(self.library.backfill(), [f"{DAY}/job0001video"])
        self.assertEqual(self.library.list(OWNER)["items"], [])

    def test_backfill_can_be_limited_to_one_owner(self):
        other_day = "v1/tenant/someone-else/2026/09/30"
        seed_video(self.store, job_id="job0009other", day=other_day)
        self.store.put(f"{other_day}/job0009other/metadata.json",
                       json.dumps(video_metadata(job_id="job0009other", owner="someone-else")).encode(),
                       "application/json")
        self.library.backfill(OWNER)
        self.assertEqual(self.library.list("someone-else")["items"], [])

    def test_index_survives_a_restart(self):
        seed_video(self.store)
        self.library.record(video_metadata(), tenant_dir=f"{DAY}/job0001video")
        restarted = lib.Library(self.store)
        self.assertEqual(len(restarted.list(OWNER)["items"]), 1)


class UserStateTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.library = lib.Library(self.store)
        seed_video(self.store)
        self.library.record(video_metadata(), tenant_dir=f"{DAY}/job0001video")

    def test_other_users_cannot_see_or_change_items(self):
        self.assertEqual(self.library.list("intruder")["items"], [])
        with self.assertRaises(lib.LibraryError) as caught:
            self.library.update_item("intruder", "job0001video", {"favorite": True})
        self.assertEqual(caught.exception.status, 404)
        with self.assertRaises(lib.LibraryError):
            self.library.read_file("intruder", "job0001video", "video-01.mp4")
        self.assertIsNone(self.library.legacy_asset("intruder", "job0001video", 0))

    def test_projects_lifecycle(self):
        project = self.library.create_project(OWNER, "  Fleet   launch ")
        self.assertEqual(project["name"], "Fleet launch")
        self.library.update_item(OWNER, "job0001video", {"projectId": project["id"]})
        self.assertEqual(self.library.rename_project(OWNER, project["id"], "Fleet")["name"], "Fleet")
        result = self.library.delete_project(OWNER, project["id"])
        self.assertEqual(result["itemsUnassigned"], 1)
        self.assertIsNone(self.library.get_item(OWNER, "job0001video")["projectId"])
        with self.assertRaises(lib.LibraryError):
            self.library.update_item(OWNER, "job0001video", {"projectId": "missing"})
        with self.assertRaises(lib.LibraryError):
            self.library.create_project(OWNER, "   ")

    def test_hide_and_unhide(self):
        self.assertTrue(self.library.update_item(OWNER, "job0001video", {"hidden": True})["hidden"])
        self.assertFalse(self.library.update_item(OWNER, "job0001video", {"hidden": False})["hidden"])
        with self.assertRaises(lib.LibraryError):
            self.library.update_item(OWNER, "job0001video", {"outputs": [{"index": 7, "favorite": True}]})

    def test_files_are_whitelisted(self):
        body, content_type = self.library.read_file(OWNER, "job0001video", "thumb-02.jpg")
        self.assertEqual(content_type, "image/jpeg")
        self.assertTrue(body)
        for name in ("../index.json", "index.json", "video-09.mp4", "input-end.png"):
            with self.assertRaises(lib.LibraryError, msg=name):
                self.library.read_file(OWNER, "job0001video", name)

    def test_legacy_asset_order_matches_the_job(self):
        self.assertEqual(self.library.legacy_asset(OWNER, "job0001video", 0)[1], "video/mp4")
        self.assertEqual(self.library.legacy_asset(OWNER, "job0001video", 1)[1], "image/jpeg")
        self.assertEqual(self.library.legacy_asset(OWNER, "job0001video", 2)[1], "video/mp4")
        self.assertIsNone(self.library.legacy_asset(OWNER, "job0001video", 4))


LIST_DEFAULTS = dict(q="", kind=None, model=None, status=None, since=None, view="all", includeHidden=False,
                     limit=60, cursor=None)


class PagingTests(unittest.TestCase):
    """Thousands of items: one object per item, server-side filters and pages."""

    def setUp(self):
        self.store = FakeStore()
        self.library = lib.Library(self.store)
        base = datetime(2026, 10, 1, tzinfo=UTC)
        for n in range(250):
            meta = video_metadata(job_id=f"job{n:05d}", takes=0)
            meta["createdAt"] = (base - timedelta(minutes=n)).isoformat()
            meta["request"]["prompt"] = "red truck" if n % 10 == 0 else "lighthouse"
            meta["request"]["model"] = "video-fast" if n % 2 else "video-quality"
            self.library.record(meta, status="failed" if n % 50 == 0 else "completed")

    def test_pages_follow_the_cursor_newest_first(self):
        seen, cursor = [], None
        while True:
            page = self.library.list(OWNER, limit=100, cursor=cursor)
            seen += [item["id"] for item in page["items"]]
            cursor = page["nextCursor"]
            if not cursor:
                break
        self.assertEqual(len(seen), 250)
        self.assertEqual(len(set(seen)), 250)
        self.assertEqual(seen[0], "job00000")
        self.assertEqual(page["total"], 250)

    def test_filters_and_counts(self):
        self.library.update_item(OWNER, "job00010", {"favorite": True})
        self.library.update_item(OWNER, "job00020", {"hidden": True})
        page = self.library.list(OWNER, q="RED", model="video-quality")
        self.assertEqual(page["total"], 24)  # 25 red trucks (all even) minus the hidden one
        self.assertEqual(self.library.list(OWNER, view="favorites")["total"], 1)
        self.assertEqual(self.library.list(OWNER, status="failed")["total"], 5)
        self.assertEqual(self.library.list(OWNER, since="2026-10-01T00:00:00+00:00")["total"], 1)
        self.assertEqual(page["counts"]["all"], 249)
        self.assertEqual(self.library.list(OWNER, include_hidden=True)["counts"]["all"], 250)
        self.assertEqual(page["models"], ["video-fast", "video-quality"])

    def test_one_write_per_change(self):
        writes = []
        original = self.store.put
        self.store.put = lambda key, body, ct: (writes.append(key), original(key, body, ct))
        self.library.update_item(OWNER, "job00007", {"favorite": True})
        self.assertEqual(writes, ["v1/library/user-123/items/job00007/item.json"])

    def test_cold_start_reads_every_item(self):
        restarted = lib.Library(self.store)
        self.assertEqual(restarted.list(OWNER)["total"], 250)


class LegacyIndexTests(unittest.TestCase):
    def test_phase_one_index_is_split_into_items(self):
        store = FakeStore()
        legacy = {"items": {"job0001video": {"id": "job0001video", "owner": OWNER, "kind": "video",
                                             "status": "completed", "createdAt": "2026-09-30T22:30:00+00:00",
                                             "prompt": "p", "request": {}, "outputs": [], "inputs": {},
                                             "favorite": True, "projectId": "p1"}},
                  "projects": {"p1": {"id": "p1", "name": "Ads", "createdAt": "x", "updatedAt": "x"}}}
        store.put("v1/library/user-123/index.json", json.dumps(legacy).encode(), "application/json")
        listing = lib.Library(store).list(OWNER)
        self.assertTrue(listing["items"][0]["favorite"])
        self.assertEqual(listing["projects"][0]["name"], "Ads")
        self.assertIn("v1/library/user-123/items/job0001video/item.json", store.objects)
        self.assertIn("v1/library/user-123/projects.json", store.objects)
        # A second process reads the split form.
        self.assertEqual(lib.Library(store).list(OWNER)["projects"][0]["id"], "p1")


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.original = main.library
        main.library = lib.Library(self.store)
        seed_video(self.store)
        main.library.record(video_metadata(), tenant_dir=f"{DAY}/job0001video")

    def tearDown(self):
        main.library = self.original
        main.jobs.clear()
        main.references.clear()

    def test_list_and_patch(self):
        listing = asyncio.run(main.list_library(**LIST_DEFAULTS, x_burtson_owner=OWNER))
        self.assertEqual(len(listing["items"]), 1)
        project = asyncio.run(main.create_project(main.ProjectBody(name="Ads"), x_burtson_owner=OWNER))
        item = asyncio.run(main.update_library_item(
            "job0001video", main.LibraryItemChange(projectId=project["id"], favorite=True), x_burtson_owner=OWNER))
        self.assertEqual(item["projectId"], project["id"])
        # Explicit null clears the project; omitted fields are left alone.
        item = asyncio.run(main.update_library_item(
            "job0001video", main.LibraryItemChange.model_validate({"projectId": None}), x_burtson_owner=OWNER))
        self.assertIsNone(item["projectId"])
        self.assertTrue(item["favorite"])
        item = asyncio.run(main.update_library_item(
            "job0001video", main.LibraryItemChange.model_validate({"outputs": [{"index": 0, "favorite": True}]}),
            x_burtson_owner=OWNER))
        self.assertTrue(item["outputs"][0]["favorite"])

    def test_errors_map_to_http(self):
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(main.get_library_item("nope", x_burtson_owner=OWNER))
        self.assertEqual(caught.exception.status_code, 404)
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(main.get_library_file("job0001video", "index.json", x_burtson_owner=OWNER))
        self.assertEqual(caught.exception.status_code, 404)

    def test_file_is_served_cacheable(self):
        response = asyncio.run(main.get_library_file("job0001video", "poster-01.jpg", x_burtson_owner=OWNER))
        self.assertEqual(response.media_type, "image/jpeg")
        self.assertIn("immutable", response.headers["cache-control"])

    def test_job_assets_fall_back_to_history(self):
        response = asyncio.run(main.get_asset("job0001video", 0, x_burtson_owner=OWNER))
        self.assertEqual(response.media_type, "video/mp4")
        with self.assertRaises(HTTPException):
            asyncio.run(main.get_asset("job0001video", 0, x_burtson_owner="intruder"))

    def test_finished_live_job_is_recorded(self):
        day = "v1/tenant/user-123/2026/10/01"
        self.store.put(f"{day}/livejob00001/image-01.png", png(), "image/png")
        self.store.put(f"{day}/references/ref00000live.png", png(), "image/png")
        main.references["ref00000live"] = main.Reference(
            id="ref00000live", owner=OWNER, key=f"{day}/references/ref00000live.png", kind="reference",
            filename="a.png", contentType="image/png", width=64, height=64, bytes=1)
        job = main.Job(id="livejob00001", owner=OWNER, status="completed",
                       request={"prompt": "logo", "model": "flux-schnell", "seed": 1, "referenceId": "ref00000live"},
                       images=[{"key": f"{day}/livejob00001/image-01.png", "width": 64, "height": 64, "seed": 1}],
                       assetKeys=[f"{day}/livejob00001/image-01.png"], startedAt=datetime.now(UTC).isoformat())
        asyncio.run(main.record_in_library(job))
        item = main.library.get_item(OWNER, "livejob00001")
        self.assertEqual(item["inputs"], {"reference": "input-reference.png"})
        self.assertEqual(item["outputs"][0]["file"], "image-01.png")

    def test_running_job_is_not_recorded(self):
        job = main.Job(id="running00001", owner=OWNER, status="running", request={"prompt": "x"})
        asyncio.run(main.record_in_library(job))
        self.assertFalse(main.library.has(OWNER, "running00001"))


class SeedTests(unittest.TestCase):
    def tearDown(self):
        main.jobs.clear()
        while not main.queue.empty():
            main.queue.get_nowait()

    def test_random_seeds_fit_a_javascript_number_and_carry_text(self):
        job = asyncio.run(main.generate(main.GenerationRequest(prompt="a brass robot"), x_burtson_owner=OWNER))
        self.assertLess(job["request"]["seed"], 2**53)
        self.assertEqual(job["seedText"], str(job["request"]["seed"]))

    def test_big_seed_as_string_is_accepted_exactly(self):
        request = main.VideoRequest.model_validate({"prompt": "a lighthouse", "seed": "3458764513820540928"})
        self.assertEqual(request.seed, 3458764513820540928)


class ReferenceRestartTests(unittest.TestCase):
    def tearDown(self):
        main.references.clear()

    def test_reference_record_reloads_after_a_restart(self):
        saved = {}
        with mock.patch.object(main, "upload", side_effect=lambda key, body, ct, exp: saved.update({key: body})):
            reference = main.Reference(id="ref0000restart", owner=OWNER, key="k", kind="reference",
                                       filename="a.png", contentType="image/png", width=64, height=64, bytes=1)
            main.save_reference(reference)
        main.references.clear()
        client = mock.MagicMock()
        client.get_object.side_effect = lambda Bucket, Key: {"Body": io.BytesIO(saved[Key])}
        with mock.patch.object(main, "s3_client", return_value=client):
            found = main.owned_reference("ref0000restart", OWNER, expected_kind="reference")
            self.assertEqual(found.width, 64)
            with self.assertRaises(HTTPException):
                main.owned_reference("ref0000restart", "intruder")


class OrphanPromptTests(unittest.TestCase):
    def test_startup_clears_prompts_it_does_not_own(self):
        calls = []

        class FakeClient:
            def __init__(self, *a, **k): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def get(self, url):
                return mock.MagicMock(json=lambda: {"queue_running": [[1, "abc"]], "queue_pending": []})
            async def post(self, url, json=None):
                calls.append((url.rsplit("/", 1)[-1], json))

        with mock.patch.object(main.httpx, "AsyncClient", FakeClient):
            asyncio.run(main.clear_orphaned_prompts())
        self.assertEqual(calls, [("queue", {"clear": True}), ("interrupt", None)])

    def test_worker_down_is_fine(self):
        with mock.patch.object(main, "COMFY_URL", "http://127.0.0.1:9"):
            asyncio.run(main.clear_orphaned_prompts())


class ReaperTests(unittest.TestCase):
    def test_pending_jobs_keep_their_uploads(self):
        reference = main.Reference(id="ref0000pending", owner=OWNER, key=f"{DAY}/references/ref0000pending.png",
                                   kind="reference", filename="a.png", contentType="image/png",
                                   width=64, height=64, bytes=1)
        main.references[reference.id] = reference
        main.jobs["queued01"] = main.Job(id="queued01", owner=OWNER, request={"referenceId": reference.id})
        try:
            keep = main.pending_input_keys()
        finally:
            main.jobs.clear()
            main.references.clear()
        self.assertIn(reference.key, keep)
        old = datetime.now(UTC) - timedelta(days=3)
        client = mock.MagicMock()
        client.get_paginator.return_value.paginate.return_value = [{"Contents": [
            {"Key": reference.key, "LastModified": old}, {"Key": f"{DAY}/references/other.png", "LastModified": old}]}]
        with mock.patch.object(main, "s3_client", return_value=client):
            self.assertEqual(main.reap_expired_objects(keep), 1)

    def test_reaper_skips_kept_prefixes(self):
        old = datetime.now(UTC) - timedelta(days=3)
        contents = [{"Key": f"{DAY}/keepme/video-01.mp4", "LastModified": old},
                    {"Key": f"{DAY}/gone/video-01.mp4", "LastModified": old},
                    {"Key": f"{DAY}/fresh/video-01.mp4", "LastModified": datetime.now(UTC)}]
        client = mock.MagicMock()
        client.get_paginator.return_value.paginate.return_value = [{"Contents": contents}]
        with mock.patch.object(main, "s3_client", return_value=client):
            deleted = main.reap_expired_objects([f"{DAY}/keepme"])
        self.assertEqual(deleted, 1)
        objects = client.delete_objects.call_args.kwargs["Delete"]["Objects"]
        self.assertEqual(objects, [{"Key": f"{DAY}/gone/video-01.mp4"}])

    def test_delete_objects_gets_content_md5(self):
        # The deployed MinIO refuses DeleteObjects without Content-MD5.
        fake = mock.MagicMock()
        with mock.patch.dict("os.environ", {"MINIO_ENDPOINT": "http://minio:9000", "MINIO_ACCESS_KEY": "a",
                                            "MINIO_SECRET_KEY": "b"}), \
                mock.patch.object(main.boto3, "client", return_value=fake):
            main.s3_client()
        events = [call.args[0] for call in fake.meta.events.register_first.call_args_list]
        self.assertIn("request-created.s3.DeleteObjects", events)
        request = mock.MagicMock(body=b"<Delete/>", headers={})
        main.add_lifecycle_content_md5(request)
        self.assertIn("Content-MD5", request.headers)

if __name__ == "__main__":
    unittest.main()
