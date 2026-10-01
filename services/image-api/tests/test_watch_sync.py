"""The watch sync against a fake watch (an httpx MockTransport) and the library's FakeStore."""
import json
import unittest
from datetime import UTC, datetime, timedelta

import httpx
import mongomock

from app import library as lib
from app import watch_sync as ws
from tests.test_library import DAY, OWNER, FakeStore, png, seed_video, video_metadata


class FakeStoreWithDelete(FakeStore):
    def delete(self, key):
        self.objects.pop(key, None)


class FakeWatch:
    """Just enough of watch's /api/internal/studio routes."""

    def __init__(self):
        self.items: dict[str, dict] = {}   # tag -> item
        self.deleted: dict[str, dict] = {}
        self.imports: list[dict] = []
        self.fail_next = 0
        self.refuse: set[str] = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Watch-Service-Key"] == "k"
        if request.url.path.endswith("/lookup"):
            body = json.loads(request.content)
            items = []
            for tag in body["importedFrom"]:
                if tag in self.items:
                    item = {**self.items[tag], "state": "present"}
                    if body.get("includePlayback"):
                        item["mp4Url"] = f"https://r2.test/{item['videoId']}.mp4"
                    items.append(item)
                elif tag in self.deleted:
                    items.append({**self.deleted[tag], "state": "deleted"})
                else:
                    items.append({"importedFrom": tag, "state": "missing"})
            return httpx.Response(200, json={"items": items})
        if request.url.path.endswith("/imports"):
            if self.fail_next:
                self.fail_next -= 1
                return httpx.Response(503, json={"message": "busy"})
            raw = request.content
            meta_start = raw.index(b"{")
            meta = json.loads(raw[meta_start:raw.index(b"\r\n--", meta_start)])
            tag = meta["importedFrom"]
            if tag in self.refuse:
                return httpx.Response(400, json={"message": "bad"})
            if tag in self.deleted:
                return httpx.Response(410, json={**self.deleted[tag], "state": "deleted"})
            if tag in self.items:
                return httpx.Response(200, json={**self.items[tag], "state": "present", "created": False})
            self.imports.append(meta)
            item = {"importedFrom": tag, "videoId": f"v{len(self.imports)}", "url": f"https://watch.test/v/v{len(self.imports)}",
                    "title": meta["title"], "kind": "image" if ".png" in raw.decode("latin-1") else "video",
                    "collectionName": (meta.get("collection") or {}).get("name") or "Burtson Video Studio"}
            self.items[tag] = item
            return httpx.Response(201, json={**item, "state": "present", "created": True})
        return httpx.Response(404)

    def delete(self, tag):
        item = self.items.pop(tag)
        self.deleted[tag] = {"importedFrom": tag, "videoId": item["videoId"], "title": item["title"],
                             "deletedAt": "2026-10-01T00:00:00Z"}


class Clock:
    def __init__(self):
        self.now = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)

    def __call__(self):
        return self.now


def image_metadata(job_id="job0003image", count=2):
    return {"jobId": job_id, "owner": OWNER, "createdAt": "2026-09-30T23:00:00+00:00", "kind": "image",
            "request": {"prompt": "a harbor bakery sign", "model": "flux-schnell", "steps": 4, "seed": 7},
            "images": [{"key": f"{DAY}/{job_id}/image-{n + 1:02d}.png", "seed": 7 + n, "width": 1024,
                        "height": 1024, "model": "flux-schnell"} for n in range(count)], "error": None}


class WatchSyncTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStoreWithDelete()
        self.library = lib.Library(self.store)
        self.watch = FakeWatch()
        self.clock = Clock()
        client = ws.WatchClient("http://watch.test", "k", transport=httpx.MockTransport(self.watch.handler))
        client.download = lambda url: b"from-r2:" + url.encode()
        self.db = mongomock.MongoClient().db
        self.sync = ws.WatchSync(self.library, client, productions_db=lambda: self.db,
                                 read_production_object=lambda key: self.store.get(key),
                                 drop_after_days=7, clock=self.clock)
        seed_video(self.store)
        self.library.record(video_metadata(), tenant_dir=f"{DAY}/job0001video")

    def outputs(self, job_id="job0001video"):
        return self.library.get_item(OWNER, job_id)["outputs"]

    def test_takes_and_images_import_once_with_studio_metadata(self):
        for n in (1, 2):
            self.store.put(f"{DAY}/job0003image/image-{n:02d}.png", png(), "image/png")
        self.library.record(image_metadata(), tenant_dir=f"{DAY}/job0003image")
        stats = self.sync.run_once()
        self.assertEqual(stats["imported"], 4)
        tags = sorted(m["importedFrom"] for m in self.watch.imports)
        self.assertEqual(tags, ["studio:job0001video:take1", "studio:job0001video:take2",
                                "studio:job0003image:image1", "studio:job0003image:image2"])
        meta = next(m for m in self.watch.imports if m["importedFrom"] == "studio:job0001video:take2")
        self.assertEqual(meta["ownerId"], OWNER)
        self.assertNotIn("collection", meta)  # watch's default "Burtson Video Studio"
        self.assertEqual(meta["title"], "truck at dusk · take 2")
        self.assertEqual(meta["studio"]["seed"], 1042)
        self.assertEqual(meta["studio"]["model"], "wan22-i2v-a14b")
        self.assertEqual(meta["studio"]["prompt"], "truck at dusk")
        watch = self.outputs()[1]["watch"]
        self.assertEqual(watch["state"], "present")
        self.assertEqual(watch["url"], "https://watch.test/v/v2")
        self.assertEqual(watch["tag"], "studio:job0001video:take2")

        # A second pass imports nothing; re-recording the job keeps the watch state.
        self.assertEqual(self.sync.run_once()["imported"], 0)
        self.library.record(video_metadata(), tenant_dir=f"{DAY}/job0001video")
        self.assertEqual(self.outputs()[0]["watch"]["videoId"], "v1")
        self.assertEqual(len(self.watch.imports), 4)

    def test_already_in_watch_is_recorded_not_uploaded(self):
        self.watch.items["studio:job0001video:take1"] = {"importedFrom": "studio:job0001video:take1", "videoId": "hand1",
                                                         "url": "https://watch.test/v/hand1", "title": "Hand import"}
        stats = self.sync.run_once()
        self.assertEqual((stats["alreadyThere"], stats["imported"]), (1, 1))
        self.assertEqual(self.outputs()[0]["watch"]["videoId"], "hand1")

    def test_hidden_takes_wait_and_errors_back_off(self):
        self.library.update_item(OWNER, "job0001video", {"outputs": [{"index": 1, "hidden": True}]})
        self.watch.fail_next = 1
        stats = self.sync.run_once()
        self.assertEqual(stats["failed"], 1)
        first = self.outputs()[0]["watch"]
        self.assertEqual(first["state"], "pending")
        self.assertNotIn("watch", self.outputs()[1])
        # Not due yet: nothing happens; after the back-off it imports.
        self.assertEqual(self.sync.run_once()["imported"], 0)
        self.clock.now += timedelta(minutes=2)
        self.assertEqual(self.sync.run_once()["imported"], 1)
        self.assertEqual(self.outputs()[0]["watch"]["attempts"], 2)

    def test_refusals_are_not_retried(self):
        self.watch.refuse.add("studio:job0001video:take1")
        self.assertEqual(self.sync.run_once()["refused"], 1)
        self.clock.now += timedelta(hours=2)
        self.sync.run_once()
        self.assertEqual(self.outputs()[0]["watch"]["state"], "refused")

    def test_rename_and_delete_in_watch_flow_back(self):
        self.sync.run_once()
        self.watch.items["studio:job0001video:take1"]["title"] = "Renamed by Mark"
        self.watch.delete("studio:job0001video:take2")
        stats = self.sync.run_once()
        self.assertEqual(stats["deleted"], 1)
        self.assertEqual(self.outputs()[0]["watch"]["title"], "Renamed by Mark")
        self.assertEqual(self.outputs()[1]["watch"]["state"], "deleted")
        # A deleted take is never imported again.
        self.clock.now += timedelta(days=1)
        self.sync.run_once()
        self.assertEqual(len(self.watch.imports), 2)

    def test_local_mp4_dropped_after_seven_days_and_served_from_watch(self):
        self.sync.run_once()
        local = "v1/library/user-123/items/job0001video/video-01.mp4"
        self.clock.now += timedelta(days=6)
        self.sync.run_once()
        self.assertIn(local, self.store.objects)
        self.clock.now += timedelta(days=1, minutes=1)
        self.assertEqual(self.sync.run_once()["dropped"], 2)
        self.assertNotIn(local, self.store.objects)
        self.assertIn("v1/library/user-123/items/job0001video/thumb-01.jpg", self.store.objects)
        self.assertTrue(self.outputs()[0]["localDropped"])
        body, content_type = self.library.read_file(OWNER, "job0001video", "video-01.mp4")
        self.assertEqual(body, b"from-r2:https://r2.test/v1.mp4")
        self.assertEqual(content_type, "video/mp4")

    def test_keep_forever_when_drop_days_is_zero(self):
        self.sync.drop_after = None
        self.sync.run_once()
        self.clock.now += timedelta(days=30)
        self.assertEqual(self.sync.run_once()["dropped"], 0)

    def test_production_takes_go_to_their_collection_with_story_order_titles(self):
        db = self.db
        db.productions.insert_one({"_id": "pr1", "owner": OWNER, "title": "Harbor Bakery", "logline": "A night shift",
                                   "aspect": "16:9"})
        db.episodes.insert_one({"_id": "ep1", "productionId": "pr1", "order": 1, "title": "Pilot"})
        db.scenes.insert_one({"_id": "sc1", "productionId": "pr1", "episodeId": "ep1", "order": 2, "title": "Dawn"})
        db.shots.insert_one({"_id": "sh1", "productionId": "pr1", "order": 3, "title": "Truck arrives"})
        prefix = "v1/productions/user-123/pr1/takes/tk_abc"
        self.store.put(f"{prefix}/video-01.mp4", b"take", "video/mp4")
        base = {"owner": OWNER, "productionId": "pr1", "episodeId": "ep1", "sceneId": "sc1", "shotId": "sh1",
                "prompt": "a truck pulls up", "model": "video-quality", "resolution": "720p", "seed": 9,
                "prefix": prefix, "files": {"video": "video-01.mp4"}, "createdAt": "2026-10-01T03:00:00+00:00"}
        db.takes.insert_one({**base, "_id": "tk_abc", "takeIndex": 0, "status": "ready"})
        db.takes.insert_one({**base, "_id": "tk_rej", "takeIndex": 1, "status": "rejected"})
        self.sync.run_once()
        meta = next(m for m in self.watch.imports if m["importedFrom"].startswith("studio:tk_"))
        self.assertEqual(meta["importedFrom"], "studio:tk_abc:take1")
        self.assertEqual(meta["title"], "E01 S02 Shot 03 · Truck arrives · take 1")
        self.assertEqual(meta["collection"], {"key": "studio:production:pr1", "name": "Harbor Bakery",
                                              "description": "A night shift"})
        self.assertEqual(meta["studio"]["productionTitle"], "Harbor Bakery")
        self.assertEqual(meta["studio"]["episodeTitle"], "Pilot")
        self.assertEqual(db.takes.find_one({"_id": "tk_abc"})["watch"]["state"], "present")
        self.assertNotIn("watch", db.takes.find_one({"_id": "tk_rej"}))


if __name__ == "__main__":
    unittest.main()
