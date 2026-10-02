"""Audio phase: music requests and workflow, the finish mix graph (levels, ducking,
timing, captions, bookends), estimates, History/watch handling of audio, and an
end-to-end finish rendered with the real ffmpeg when it is installed."""
import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from fastapi import HTTPException
from pydantic import ValidationError

from app import audio_workflows as aw
from app import estimates as est
from app import library as lib
from app import main
from app import mix
from app import watch_sync as ws

from tests.test_library import FakeStore, jpeg

OWNER = "user-123"
DAY = "v1/tenant/user-123/2026/10/01"
HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def clear_state():
    main.jobs.clear()
    main.references.clear()
    main.idempotency.clear()
    for q in (main.queue, main.finish_queue):
        while not q.empty():
            q.get_nowait()
            q.task_done()


# --- music requests and the ACE-Step workflow -------------------------------------------


class MusicPlanTests(unittest.TestCase):
    def test_instrumental_defaults(self):
        plan = aw.plan_music(prompt="warm corporate bed, soft pads", seed=7, duration_seconds=30)
        self.assertEqual(plan.lyrics, "[Instrumental]")
        self.assertIn("instrumental", plan.tags)
        self.assertEqual(plan.bpm, aw.DEFAULT_BPM_INSTRUMENTAL)
        self.assertEqual(plan.keyscale, "C major")
        self.assertEqual(plan.render_seconds, 30)

    def test_genre_mood_fold_into_tags_without_duplicates(self):
        self.assertEqual(aw.music_tags("cinematic tension", "cinematic", "dark"), "cinematic tension, dark")
        tense = aw.plan_music(prompt="courtroom tension", seed=1, duration_seconds=20, mood="tense")
        self.assertEqual(tense.keyscale, "A minor")

    def test_song_needs_lyrics(self):
        with self.assertRaisesRegex(ValueError, "lyrics are required"):
            aw.plan_music(prompt="pop song", seed=1, duration_seconds=30, instrumental=False)
        song = aw.plan_music(prompt="pop song", seed=1, duration_seconds=30, instrumental=False,
                             lyrics="[Verse]\nhello")
        self.assertEqual(song.lyrics, "[Verse]\nhello\n\n[Outro]")   # an ending is always asked for
        self.assertEqual(song.bpm, aw.DEFAULT_BPM_SONG)
        self.assertIn(aw.ENDING_TAG, song.tags)
        self.assertEqual(song.render_seconds, 30 + aw.ENDING_TAIL_SECONDS)
        self.assertEqual(song.ending, (21.0, 36.0))
        kept = aw.plan_music(prompt="pop song", seed=1, duration_seconds=30, instrumental=False,
                             lyrics="[Verse]\nhello\n[Outro]\nbye")
        self.assertEqual(kept.lyrics, "[Verse]\nhello\n[Outro]\nbye")
        with self.assertRaisesRegex(ValueError, "cannot be loopable"):
            aw.plan_music(prompt="pop song", seed=1, duration_seconds=30, instrumental=False, lyrics="x", loopable=True)

    def test_song_length_from_lyrics_and_limits(self):
        words = "\n".join(["[Intro]", "[Verse 1]"] + [f"line number {i}" for i in range(16)]
                          + ["[Chorus]"] + [f"chorus line {i}" for i in range(8)] + ["[Guitar Solo]", "[Outro]"])
        song = aw.plan_music(prompt="rock", seed=1, duration_seconds=None, instrumental=False, lyrics=words, bpm=120)
        # 24 lines x 2 bars + intro 8 + solo 16 + outro 8 = 80 bars of 4/4 at 120 bpm = 160 s, +10 % = 176 s
        self.assertEqual(song.duration_seconds, 176.0)
        self.assertTrue(song.duration_derived)
        self.assertTrue(song.describe()["durationDerived"])
        short = aw.plan_music(prompt="rock", seed=1, duration_seconds=None, instrumental=False, lyrics="hi", bpm=120)
        self.assertEqual(short.duration_seconds, 60.0)
        long = aw.plan_music(prompt="rock", seed=1, duration_seconds=None, instrumental=False,
                             lyrics="\n".join(f"l {i}" for i in range(400)), bpm=60)
        self.assertEqual(long.duration_seconds, aw.SONG_MAX_SECONDS)
        self.assertEqual(aw.plan_music(prompt="rock", seed=1, duration_seconds=350, instrumental=False,
                                       lyrics="hi").duration_seconds, 350)
        with self.assertRaisesRegex(ValueError, "for a song"):
            aw.plan_music(prompt="rock", seed=1, duration_seconds=361, instrumental=False, lyrics="hi")
        with self.assertRaises(ValueError):
            aw.plan_music(prompt="bed", seed=1, duration_seconds=300)
        bed = aw.plan_music(prompt="bed", seed=1, duration_seconds=None)
        self.assertEqual((bed.duration_seconds, bed.render_seconds, bed.ending), (30.0, 30.0, (27.0, 30.0)))
        loop = aw.plan_music(prompt="bed", seed=1, duration_seconds=30, loopable=True)
        self.assertIsNone(loop.ending)
        self.assertNotIn(aw.ENDING_TAG, loop.tags)

    def test_limits(self):
        for seconds in (2.9, 241):
            with self.assertRaises(ValueError):
                aw.plan_music(prompt="x y z", seed=1, duration_seconds=seconds)
        with self.assertRaisesRegex(ValueError, "keyscale"):
            aw.plan_music(prompt="x y z", seed=1, duration_seconds=10, keyscale="H major")
        with self.assertRaisesRegex(ValueError, "loopable"):
            aw.plan_music(prompt="x y z", seed=1, duration_seconds=10, loopable=True)

    def test_loopable_renders_the_overlap(self):
        plan = aw.plan_music(prompt="loop bed", seed=1, duration_seconds=30, loopable=True)
        self.assertEqual(plan.render_seconds, 34)
        self.assertEqual(plan.duration_seconds, 30)

    def test_workflow_matches_comfy_native_ace15_nodes(self):
        plan = aw.plan_music(prompt="bed", seed=5, duration_seconds=30, bpm=96, keyscale="D minor")
        wf = aw.ace_workflow(plan, filename_prefix="burtson-audio/x-1")
        self.assertEqual(wf["clip"]["inputs"]["type"], "ace")
        self.assertEqual(plan.model, "music-ace15-xl")
        self.assertEqual(wf["unet"]["inputs"]["unet_name"], "acestep_v1.5_xl_sft_bf16.safetensors")
        self.assertEqual(wf["clip"]["inputs"]["clip_name2"], "qwen_4b_ace15.safetensors")
        self.assertEqual(wf["encode"]["class_type"], "TextEncodeAceStepAudio1.5")
        self.assertEqual(wf["encode"]["inputs"]["bpm"], 96)
        self.assertEqual(wf["encode"]["inputs"]["keyscale"], "D minor")
        self.assertEqual(wf["encode"]["inputs"]["duration"], 30)
        self.assertEqual(wf["latent"]["class_type"], "EmptyAceStep1.5LatentAudio")
        self.assertEqual(wf["sampler"]["inputs"]["steps"], 50)
        self.assertEqual(wf["sampler"]["inputs"]["cfg"], 5.0)
        self.assertEqual(wf["shift"]["inputs"]["shift"], 1.0)
        self.assertEqual(wf["save"]["class_type"], "SaveAudio")
        # every link points at a node that exists
        for node in wf.values():
            for value in node["inputs"].values():
                if isinstance(value, list):
                    self.assertIn(value[0], wf)
        self.assertEqual(set(aw.plan_checkpoints(plan)) - set(aw.CHECKPOINT_SHA256), set())

    def test_fast_model_keeps_the_turbo_graph(self):
        plan = aw.plan_music(prompt="bed", seed=5, duration_seconds=30, model="music-ace15")
        wf = aw.ace_workflow(plan, filename_prefix="burtson-audio/x-1")
        self.assertEqual(wf["unet"]["inputs"]["unet_name"], "acestep_v1.5_turbo.safetensors")
        self.assertEqual(wf["clip"]["inputs"]["clip_name2"], "qwen_1.7b_ace15.safetensors")
        self.assertEqual((wf["sampler"]["inputs"]["steps"], wf["sampler"]["inputs"]["cfg"]), (8, 1.0))
        self.assertEqual(wf["shift"]["inputs"]["shift"], 3.0)
        self.assertEqual(plan.describe()["workflowVersion"], "ace15-turbo-v1")
        with self.assertRaises(ValueError):
            aw.plan_music(prompt="bed", seed=5, duration_seconds=30, model="nope")
        self.assertEqual(set(aw.CHECKPOINT_SHA256),
                         {name for alias in aw.MUSIC_MODELS
                          for name in aw.plan_checkpoints(aw.plan_music(prompt="b c d", seed=1, duration_seconds=10,
                                                                         model=alias))})


class MusicRouteTests(unittest.TestCase):
    def tearDown(self):
        clear_state()

    def test_submit_queues_an_audio_job_with_estimate(self):
        job = asyncio.run(main.generate_music(main.MusicRequest(prompt="light corporate bed", durationSeconds=30,
                                                                variants=2), x_burtson_owner=OWNER, idempotency_key=None))
        fast = asyncio.run(main.generate_music(main.MusicRequest(prompt="light corporate bed", model="music-ace15"),
                                               x_burtson_owner=OWNER, idempotency_key=None))
        self.assertEqual(fast["request"]["plan"]["steps"], 8)
        self.assertEqual(fast["request"]["estimate"]["key"], est.MUSIC_KEY)
        main.queue.get_nowait()
        main.queue.task_done()
        self.assertEqual(job["kind"], "audio")
        self.assertEqual(job["request"]["model"], aw.DEFAULT_MUSIC_MODEL)
        self.assertEqual(job["request"]["plan"]["bpm"], 100)
        self.assertGreater(job["request"]["estimate"]["seconds"], 0)
        self.assertEqual(main.queue.qsize(), 1)

    def run_music(self, loudness):
        """execute_music with ComfyUI and storage faked; ``loudness`` is the mastered LUFS per sampled take."""
        job = main.create_music_job(main.MusicRequest(prompt="light corporate bed", durationSeconds=30), OWNER)
        main.queue.get_nowait()
        main.queue.task_done()
        seeds, levels = [], iter(loudness)

        async def sample(client, job, plan, variant):
            seeds.append(plan.seed)
            return b"raw"

        def master(raw, plan):
            return {"lufs": next(levels), "truePeak": -1.5, "durationSeconds": 30.0, "sampleRate": 48000,
                    "channels": 2, "wavBytes": b"wav", "mp3Bytes": b"mp3", "waveBytes": b"jpg"}

        with mock.patch.object(main, "wait_for_worker", mock.AsyncMock(return_value=True)), \
                mock.patch.object(main, "run_music_prompt", sample), \
                mock.patch.object(main, "master_music_bytes", master), \
                mock.patch.object(main, "upload"), mock.patch.object(main, "record_music_timing"):
            try:
                asyncio.run(main.execute_music(job))
            except RuntimeError as exc:
                return job, seeds, exc
        return job, seeds, None

    def test_a_silent_take_is_resampled_with_a_new_seed(self):
        job, seeds, error = self.run_music([-70.0, -16.0])
        self.assertIsNone(error)
        self.assertEqual(job.status, "completed")
        self.assertEqual(len(seeds), 2)
        self.assertNotEqual(seeds[0], seeds[1])
        self.assertEqual(job.audios[0]["seed"], seeds[1])
        self.assertEqual(job.audios[0]["lufs"], -16.0)

    def test_a_take_that_stays_silent_fails_instead_of_completing(self):
        job, seeds, error = self.run_music([-70.0] * (1 + main.MUSIC_SILENT_RETRIES))
        self.assertIsNotNone(error)
        self.assertIn("silent", str(error))
        self.assertEqual(len(seeds), 1 + main.MUSIC_SILENT_RETRIES)
        self.assertEqual(job.audios, [])

    def test_sfx_and_bad_requests_are_400(self):
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(main.generate_music(main.MusicRequest(prompt="door slam", kind="sfx"), x_burtson_owner=OWNER, idempotency_key=None))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("licence", caught.exception.detail)
        with self.assertRaises(HTTPException):
            asyncio.run(main.generate_music(main.MusicRequest(prompt="a song", instrumental=False),
                                            x_burtson_owner=OWNER, idempotency_key=None))
        with self.assertRaises(ValidationError):
            main.MusicRequest(prompt="x y z", durationSeconds=400)
        with self.assertRaises(HTTPException):     # 300 s is a song length; instrumentals stop at 240
            asyncio.run(main.generate_music(main.MusicRequest(prompt="x y z", durationSeconds=300),
                                            x_burtson_owner=OWNER, idempotency_key=None))
        with self.assertRaises(ValidationError):
            main.MusicRequest(prompt="x y z", bpm=500)

    def test_estimate_route(self):
        ok = asyncio.run(main.estimate_audio(main.MusicEstimateRequest(durationSeconds=60, variants=2)))
        self.assertTrue(ok["valid"])
        self.assertEqual(ok["variants"], 2)
        bad = asyncio.run(main.estimate_audio(main.MusicEstimateRequest(durationSeconds=400)))
        self.assertFalse(bad["valid"])

    def test_capabilities_say_sfx_is_unavailable(self):
        caps = asyncio.run(main.audio_capabilities())
        self.assertTrue(caps["music"]["available"])
        self.assertFalse(caps["sfx"]["available"])
        self.assertEqual(caps["finish"]["bedDb"]["balanced"], -20.0)


class EstimateTests(unittest.TestCase):
    def test_music_estimate_scales_with_length_and_takes(self):
        cal = est.audio_calibration()
        self.assertEqual(est.estimate_music(cal, 30)["key"], est.MUSIC_XL_KEY)
        one = est.estimate_music(cal, 30, model="music-ace15")
        self.assertEqual(one["loadSeconds"], 30)
        self.assertEqual(one["perTakeSeconds"], round(0.5 * 30 + 4))
        two = est.estimate_music(cal, 60, 2, loopable=True, model="music-ace15")
        self.assertEqual(two["perTakeSeconds"], round(0.5 * 64 + 4))
        self.assertEqual(two["seconds"], round(30 + 2 * (0.5 * 64 + 4)))

    def test_music_estimate_calibrates(self):
        cal = est.audio_calibration()
        for _ in range(3):
            cal.record(est.MUSIC_KEY, 0.2, 12)
        measured = est.estimate_music(cal, 30, model="music-ace15")
        self.assertEqual(measured["basis"], "measured")
        self.assertEqual(measured["ratePerSecond"], 0.2)
        self.assertEqual(measured["loadSeconds"], 12)

    def test_finish_estimate(self):
        cal = est.audio_calibration()
        copy = est.estimate_finish(cal, output_seconds=10, encode=False, resolution="720p")
        self.assertEqual(copy["key"], "finish|copy")
        self.assertEqual(copy["claimSeconds"], 0)
        encode = est.estimate_finish(cal, output_seconds=10, encode=True, resolution="1080p", music_seconds=11)
        self.assertEqual(encode["key"], "finish|encode|1080p")
        self.assertGreater(encode["musicSeconds"], 0)
        self.assertEqual(encode["seconds"], encode["mixSeconds"] + encode["musicSeconds"])
        self.assertGreater(encode["claimSeconds"], 0)
        self.assertEqual(est.resolution_of(1920, 1080), "1080p")
        self.assertEqual(est.resolution_of(720, 1280), "720p")
        self.assertEqual(est.resolution_of(832, 480), "480p")

    def test_finish_estimate_route(self):
        plain = asyncio.run(main.estimate_finish(main.FinishEstimateRequest(videoSeconds=5)))
        self.assertFalse(plain["encode"])
        held = asyncio.run(main.estimate_finish(main.FinishEstimateRequest(videoSeconds=5, narrationSeconds=9,
                                                                          narrationLines=2, musicPrompt=True)))
        self.assertTrue(held["encode"])
        self.assertAlmostEqual(held["outputSeconds"], 9 + mix.NARRATION_LEAD + mix.NARRATION_TAIL)
        self.assertGreater(held["musicSeconds"], 0)


# --- the mix graph ------------------------------------------------------------------------


def spec(**overrides) -> mix.MixSpec:
    values = dict(video_path="take.mp4", video_duration=5.0, width=1280, height=720, fps=24.0)
    values.update(overrides)
    return mix.MixSpec(**values)


class TimelineTests(unittest.TestCase):
    def test_sequential_lines_with_lead_and_gaps(self):
        lines = [mix.Line("a.wav", 2.0, -20), mix.Line("b.wav", 3.0, -18), mix.Line("c.wav", 1.0, -19, start=9.0)]
        self.assertEqual(mix.place_lines(lines), [0.5, 2.9, 9.0])

    def test_audio_fit_holds_the_last_frame(self):
        tl = mix.timeline(spec(lines=[mix.Line("a.wav", 6.0, -20)]))
        self.assertAlmostEqual(tl.main_seconds, 0.5 + 6.0 + mix.NARRATION_TAIL)
        self.assertAlmostEqual(tl.hold_seconds, tl.main_seconds - 5.0)
        cut = mix.timeline(spec(lines=[mix.Line("a.wav", 6.0, -20)], fit="video"))
        self.assertEqual(cut.total, 5.0)
        self.assertEqual(cut.hold_seconds, 0.0)

    def test_bookends_shift_everything(self):
        logo = mix.Logo("card.png", start=True, end=True, seconds=2.0)
        tl = mix.timeline(spec(lines=[mix.Line("a.wav", 2.0, -20)], logo=logo))
        self.assertAlmostEqual(tl.main_offset, 1.5)
        self.assertEqual(tl.line_starts, [2.0])
        self.assertAlmostEqual(tl.total, 1.5 + 5.0 + 1.5)

    def test_caption_cues_split_long_lines_and_follow_timing(self):
        text = ("When a request is messy, it doesn't guess. It flags what's missing, the dispatcher fixes it, "
                "and the load goes out on time.")
        cues = mix.caption_cues([mix.Line("a.wav", 8.0, -20, text=text)], [1.0], max_chars=46)
        self.assertGreater(len(cues), 2)
        self.assertTrue(all(len(t) <= 46 for t, _, _ in cues))
        self.assertAlmostEqual(cues[0][1], 1.0)
        self.assertAlmostEqual(cues[-1][2], 9.25, places=2)
        self.assertEqual(" ".join(t for t, _, _ in cues), text)
        self.assertEqual(mix.caption_chars(1280, 720), 84)
        self.assertEqual(mix.caption_chars(720, 1280), 46)


class GraphTests(unittest.TestCase):
    def test_music_only_is_the_programme_and_copies_video(self):
        graph = mix.build_graph(spec(music=mix.Bed("m.wav", 60.0, -12.0)))
        self.assertTrue(graph.copy_video)
        self.assertEqual(graph.video_map, "0:v")
        self.assertIn("volume=-4dB", graph.filter)                     # -12 -> -16 LUFS
        self.assertNotIn("sidechaincompress", graph.filter)
        self.assertIn("alimiter=limit=0.841", graph.filter)            # -1.5 dBTP
        self.assertEqual(graph.levels["music"]["targetLufs"], -16.0)

    def test_voice_sets_speech_level_and_ducks_the_bed(self):
        line = mix.Line("v.wav", 3.0, -22.5, text="hello")
        graph = mix.build_graph(spec(lines=[line], music=mix.Bed("m.wav", 60.0, -14.0), levels="balanced"))
        self.assertIn("volume=6.5dB", graph.filter)                    # voice -22.5 -> -16
        self.assertIn("volume=-22dB", graph.filter)                    # bed -14 -> -36 (-16 - 20)
        self.assertIn("sidechaincompress=threshold=0.02:ratio=3:attack=30:release=700", graph.filter)
        self.assertIn("asplit=2[vox][key]", graph.filter)
        self.assertIn("adelay=500|500", graph.filter)

    def test_presets_move_the_bed(self):
        line = [mix.Line("v.wav", 3.0, -16.0)]
        forward = mix.build_graph(spec(lines=line, music=mix.Bed("m.wav", 60.0, -16.0), levels="voice-forward"))
        music = mix.build_graph(spec(lines=line, music=mix.Bed("m.wav", 60.0, -16.0), levels="music-forward"))
        self.assertIn("volume=-24dB", forward.filter)
        self.assertIn("ratio=4", forward.filter)
        self.assertIn("volume=-15dB", music.filter)
        self.assertIn("ratio=1.5", music.filter)
        with self.assertRaises(ValueError):
            mix.build_graph(spec(levels="loud"))

    def test_voice_only_has_no_dangling_key(self):
        graph = mix.build_graph(spec(lines=[mix.Line("v.wav", 3.0, -20.0)]))
        self.assertNotIn("[key]", graph.filter)
        self.assertNotIn("sidechaincompress", graph.filter)

    def test_short_track_loops_with_crossfades(self):
        graph = mix.build_graph(spec(video_duration=30.0, music=mix.Bed("m.wav", 12.0, -16.0)))
        self.assertIn("asplit=4", graph.filter)
        self.assertEqual(graph.filter.count("acrossfade=d=4"), 3)
        self.assertEqual(mix.loop_plan(12, 30.5), (4, 4.0))
        with self.assertRaises(ValueError):
            mix.loop_plan(6, 30)

    def test_original_audio_is_the_programme_under_music_without_voice(self):
        graph = mix.build_graph(spec(music=mix.Bed("m.wav", 60.0, -16.0), original=mix.Bed(None, 5.0, -18.0)))
        self.assertEqual(graph.levels["original"]["targetLufs"], -16.0)
        self.assertEqual(graph.levels["music"]["targetLufs"], -36.0)
        self.assertIn("[0:a]atrim", graph.filter)

    def test_captions_logo_and_hold_force_an_encode(self):
        logo = mix.Logo("card.png", start=True, end=False, seconds=2.0)
        graph = mix.build_graph(spec(lines=[mix.Line("v.wav", 7.0, -16.0, text="x")], logo=logo,
                                     captions=[("x", 2.0, 4.0, "cap0.png")]))
        self.assertFalse(graph.copy_video)
        self.assertEqual(graph.video_map, "[vout]")
        self.assertIn("tpad=stop_mode=clone", graph.filter)
        self.assertIn("between(t,0.5,2.5)", graph.filter)             # cue times relative to the take
        self.assertIn("xfade=transition=fade:duration=0.5:offset=1.5", graph.filter)
        self.assertIn(["-loop", "1", "-t", "2", "-i", "card.png"], graph.inputs)
        command = mix.ffmpeg_command(graph, "g.txt", "out.mp4", fps=24)
        self.assertIn("libx264", command)
        last_t = len(command) - 1 - command[::-1].index("-t")
        self.assertEqual(command[last_t + 1], mix.num(graph.timeline.total))

    def test_silent_take_still_gets_an_audio_track(self):
        graph = mix.build_graph(spec())
        self.assertIn("anullsrc", graph.filter)

    def test_loop_seam_and_loudnorm_text(self):
        seam = mix.loop_seam_filter(30, 4)
        self.assertIn("atrim=start=30:end=34", seam)
        self.assertIn("afade=t=in:st=0:d=4:curve=qsin", seam)
        second = mix.loudnorm_second_pass({"lufs": -11.2, "truePeak": 0.3, "lra": 6.1, "threshold": -21.5,
                                           "offset": -0.2})
        self.assertIn("measured_I=-11.2", second)
        self.assertIn("linear=true", second)

    def test_parse_loudnorm_handles_silence(self):
        stderr = 'x\n{\n "input_i" : "-inf",\n "input_tp" : "-inf",\n "input_lra" : "0.00",\n' \
                 ' "input_thresh" : "-inf",\n "target_offset" : "inf"\n}\n'
        parsed = mix.parse_loudnorm(stderr)
        self.assertEqual(parsed["lufs"], -70.0)
        self.assertEqual(parsed["offset"], 0.0)


# --- finish request validation ----------------------------------------------------------


def video_item(store, library, job_id="vid000000001", owner=OWNER):
    store.put(f"{DAY}/{job_id}/video-01.mp4", b"mp4", "video/mp4")
    store.put(f"{DAY}/{job_id}/poster-01.jpg", jpeg(), "image/jpeg")
    library.record({"jobId": job_id, "owner": owner, "createdAt": "2026-10-01T10:00:00+00:00", "kind": "video",
                    "request": {"prompt": "truck at dusk", "model": "video-quality", "seed": 1},
                    "videos": [{"variant": 1, "seed": 1, "width": 1280, "height": 720, "fps": 24,
                                "durationSeconds": 5.0, "bytes": 3, "sha256": "abc", "mode": "text-to-video"}]},
                   tenant_dir=f"{DAY}/{job_id}")


def audio_reference(ref_id="aud000000001", seconds=3.0, owner=OWNER, kind="audio"):
    reference = main.Reference(id=ref_id, owner=owner, key=f"{DAY}/references/{ref_id}.wav", kind=kind,
                               filename="line.wav", contentType="audio/wav", width=0, height=0, bytes=10,
                               durationSeconds=seconds)
    main.references[ref_id] = reference
    return reference


class FinishValidationTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.library = lib.Library(self.store)
        self.patch = mock.patch.object(main, "library", self.library)
        self.patch.start()
        video_item(self.store, self.library)

    def tearDown(self):
        self.patch.stop()
        clear_state()

    def submit(self, **body):
        body.setdefault("video", {"itemId": "vid000000001", "take": 0})
        return asyncio.run(main.finish_video(main.FinishRequest(**body), x_burtson_owner=OWNER, idempotency_key=None))

    def test_valid_finish_is_queued_on_the_cpu_queue(self):
        audio_reference()
        job = self.submit(narration=[{"audioId": "aud000000001", "text": "Hello there.", "voice": "en_US-heart-local"}],
                          music={"prompt": "warm bed"}, captions=True)
        self.assertEqual(job["kind"], "finish")
        self.assertEqual(main.finish_queue.qsize(), 1)
        self.assertEqual(main.queue.qsize(), 0)                        # the GPU queue is untouched
        self.assertEqual(job["request"]["musicSource"], "prompt")
        self.assertEqual(job["request"]["sourceItem"]["file"], "video-01.mp4")
        self.assertIn("aud000000001", job["request"]["inputReferences"])
        self.assertGreater(job["request"]["estimate"]["musicSeconds"], 0)
        self.assertNotIn("inputFiles", job)

    def assert_400(self, pattern, **body):
        with self.assertRaises(HTTPException) as caught:
            self.submit(**body)
        self.assertEqual(caught.exception.status_code, 400, caught.exception.detail)
        self.assertRegex(str(caught.exception.detail), pattern)

    def test_rejections(self):
        audio_reference()
        self.assert_400("sound effects", sfx={"prompt": "door"})
        self.assert_400("take 3 not found", video={"itemId": "vid000000001", "take": 3})
        self.assert_400("exactly one", music={"prompt": "bed", "audioId": "aud000000001"})
        self.assert_400("exactly one", music={})
        self.assert_400("captions need", captions=True, narration=[{"audioId": "aud000000001"}])
        with self.assertRaises(HTTPException) as caught:
            self.submit(narration=[{"audioId": "missing00000"}])
        self.assertEqual(caught.exception.status_code, 404)
        with self.assertRaises(HTTPException):
            self.submit(video={"itemId": "doesnotexist", "take": 0})
        with self.assertRaises(ValidationError):
            main.FinishRequest(video={"itemId": "vid000000001"}, narration=[{"audioId": "aud000000001"}] * 21)
        with self.assertRaises(ValidationError):
            main.FinishRequest(video={"itemId": "vid000000001"}, levels="loud")

    def test_logo_must_be_a_logo_upload(self):
        audio_reference("img000000001", kind="reference")
        self.assert_400("expected a logo", logo={"referenceId": "img000000001"})

    def test_audio_item_as_music_must_be_audio(self):
        self.assert_400("audio item", music={"itemId": "vid000000001", "take": 0})


class ContractTests(unittest.TestCase):
    """Fields and headers the Anton proxy and the MCP tools rely on."""

    def setUp(self):
        self.store = FakeStore()
        self.library = lib.Library(self.store)
        self.patch = mock.patch.object(main, "library", self.library)
        self.patch.start()
        video_item(self.store, self.library)

    def tearDown(self):
        self.patch.stop()
        clear_state()

    def test_logo_uploads_keep_their_alpha(self):
        import io
        from PIL import Image
        logo = Image.new("RGBA", (128, 64), (0, 0, 0, 0))
        logo.paste((200, 30, 30, 255), (40, 20, 90, 44))
        raw = io.BytesIO()
        logo.save(raw, format="PNG")
        body, width, height = main.normalize_upload(raw.getvalue(), "logo")
        with Image.open(io.BytesIO(body)) as result:
            self.assertEqual(result.mode, "RGBA")
            self.assertEqual(result.getpixel((0, 0))[3], 0)
            self.assertEqual(result.getpixel((50, 30)), (200, 30, 30, 255))
        self.assertEqual((width, height), (128, 64))
        # and the upload route accepts kind=logo (Anton forwards the multipart kind as-is)
        self.assertIn("logo", str(main.upload_reference.__annotations__.get("kind")))

    def test_logo_reference_is_accepted_for_bookends(self):
        audio_reference("logo00000001", kind="logo")
        job = asyncio.run(main.finish_video(main.FinishRequest(
            video={"itemId": "vid000000001", "take": 0}, logo={"referenceId": "logo00000001"}),
            x_burtson_owner=OWNER, idempotency_key=None))
        self.assertEqual(job["request"]["logo"]["referenceId"], "logo00000001")

    def test_narration_lines_accept_the_mcp_voice_field(self):
        audio_reference()
        body = {"video": {"itemId": "vid000000001", "take": 0},
                "narration": [{"audioId": "aud000000001", "text": "Hi.", "voice": "en_US-heart-local",
                               "startSeconds": 0.5}]}
        job = asyncio.run(main.finish_video(main.FinishRequest(**body), x_burtson_owner=OWNER, idempotency_key=None))
        self.assertEqual(job["request"]["narration"][0]["voice"], "en_US-heart-local")

    def test_take_is_the_zero_based_output_index(self):
        job = asyncio.run(main.finish_video(main.FinishRequest(video={"itemId": "vid000000001", "take": 0}),
                                            x_burtson_owner=OWNER, idempotency_key=None))
        self.assertEqual(job["request"]["sourceItem"]["file"], "video-01.mp4")   # MCP take 1 -> take 0
        with self.assertRaises(HTTPException):
            asyncio.run(main.finish_video(main.FinishRequest(video={"itemId": "vid000000001", "take": 1}),
                                          x_burtson_owner=OWNER, idempotency_key=None))

    def test_idempotency_key_dedupes_every_submit(self):
        first = asyncio.run(main.finish_video(main.FinishRequest(video={"itemId": "vid000000001"}),
                                              x_burtson_owner=OWNER, idempotency_key="fin-1"))
        again = asyncio.run(main.finish_video(main.FinishRequest(video={"itemId": "vid000000001"}),
                                              x_burtson_owner=OWNER, idempotency_key="fin-1"))
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(main.finish_queue.qsize(), 1)
        music = main.MusicRequest(prompt="calm bed")
        a = asyncio.run(main.generate_music(music, x_burtson_owner=OWNER, idempotency_key="mus-1"))
        b = asyncio.run(main.generate_music(music, x_burtson_owner=OWNER, idempotency_key="mus-1"))
        self.assertEqual(a["id"], b["id"])
        image = main.GenerationRequest(prompt="a brass robot")
        c = asyncio.run(main.generate(image, x_burtson_owner=OWNER, idempotency_key="img-1"))
        d = asyncio.run(main.generate(image, x_burtson_owner=OWNER, idempotency_key="img-1"))
        self.assertEqual(c["id"], d["id"])
        self.assertEqual(main.queue.qsize(), 2)                         # one music + one image job
        other = asyncio.run(main.generate(image, x_burtson_owner="someone-else", idempotency_key="img-1"))
        self.assertNotEqual(other["id"], c["id"])


# --- History and watch ----------------------------------------------------------------------


class AudioHistoryTests(unittest.TestCase):
    def test_audio_takes_record_with_waveform_thumbs(self):
        store = FakeStore()
        library = lib.Library(store)
        job_id = "aud0000000job"
        for n in (1, 2):
            store.put(f"{DAY}/{job_id}/audio-{n:02d}.wav", b"wav", "audio/wav")
            store.put(f"{DAY}/{job_id}/audio-{n:02d}.mp3", b"mp3", "audio/mpeg")
            store.put(f"{DAY}/{job_id}/wave-{n:02d}.jpg", jpeg(), "image/jpeg")
        item = library.record({
            "jobId": job_id, "owner": OWNER, "createdAt": "2026-10-01T10:00:00+00:00", "kind": "audio",
            "request": {"prompt": "corporate bed", "model": aw.DEFAULT_MUSIC_MODEL, "seed": 3, "title": "Bed",
                        "collection": "Burtson Stock Audio", "instrumental": True},
            "audios": [{"variant": n, "seed": 3 + n, "durationSeconds": 30.0, "lufs": -16.0, "bpm": 100,
                        "mode": "music", "model": aw.DEFAULT_MUSIC_MODEL, "instrumental": True} for n in (1, 2)],
        }, tenant_dir=f"{DAY}/{job_id}")
        self.assertEqual(item["kind"], "audio")
        self.assertEqual(item["title"], "Bed")
        self.assertEqual(item["outputs"][1]["file"], "audio-02.wav")
        self.assertEqual(item["outputs"][1]["mp3"], "audio-02.mp3")
        self.assertEqual(item["outputs"][1]["thumb"], "thumb-02.jpg")
        body, content_type = library.read_file(OWNER, job_id, "audio-01.mp3")
        self.assertEqual((body, content_type), (b"mp3", "audio/mpeg"))
        self.assertEqual(library.legacy_asset(OWNER, job_id, 1), (b"mp3", "audio/mpeg"))
        self.assertEqual(library.list(OWNER, kind="audio")["total"], 1)
        self.assertEqual(library.list(OWNER, kind="video")["total"], 0)
        # watch: audio tag, WAV upload, collection and extra fields as strings
        output = library.items_of(lib.safe_owner(OWNER))[0]["outputs"][0]
        self.assertEqual(ws.history_tag(job_id, output), f"studio:{job_id}:audio1")
        meta = ws.history_metadata(library.items_of(lib.safe_owner(OWNER))[0], output, "t")
        self.assertEqual(meta["studio"]["kind"], "audio")
        self.assertEqual(meta["studio"]["extra"]["bpm"], "100")
        self.assertEqual(meta["collection"]["name"], "Burtson Stock Audio")
        self.assertTrue(all(isinstance(v, str) for v in meta["studio"]["extra"].values()))

    def test_finished_video_records_as_a_video_take(self):
        store = FakeStore()
        library = lib.Library(store)
        job_id = "fin0000000job"
        store.put(f"{DAY}/{job_id}/video-01.mp4", b"mp4", "video/mp4")
        store.put(f"{DAY}/{job_id}/poster-01.jpg", jpeg(), "image/jpeg")
        store.put(f"{DAY}/references/line.wav", b"wav", "audio/wav")
        item = library.record({
            "jobId": job_id, "owner": OWNER, "createdAt": "2026-10-01T10:00:00+00:00", "kind": "finish",
            "request": {"prompt": "truck at dusk", "model": "finish", "title": "Final"},
            "videos": [{"variant": 1, "mode": "finished", "sourceItemId": "vid000000001", "sourceTake": 0,
                        "mix": {"levels": "balanced", "lufs": -16.1}}],
            "inputFiles": {"input-narration-01.wav": f"{DAY}/references/line.wav", "bogus.txt": "x"},
        }, tenant_dir=f"{DAY}/{job_id}")
        self.assertEqual(item["kind"], "video")
        self.assertEqual(item["mode"], "finished")
        self.assertEqual(item["outputs"][0]["mix"]["levels"], "balanced")
        self.assertEqual(item["outputs"][0]["sourceItemId"], "vid000000001")
        self.assertEqual(item["inputs"], {"narration-01": "input-narration-01.wav"})
        self.assertEqual(library.read_file(OWNER, job_id, "input-narration-01.wav")[0], b"wav")
        self.assertEqual(ws.history_tag(job_id, item["outputs"][0]), f"studio:{job_id}:take1")


# --- end to end with the real ffmpeg -----------------------------------------------------------


def make_media(work: str) -> dict:
    paths = {"video": os.path.join(work, "take.mp4"), "voice": os.path.join(work, "voice.wav"),
             "music": os.path.join(work, "music.flac")}
    quiet = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    subprocess.run(quiet + ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=4", "-c:v", "libx264", "-pix_fmt",
                            "yuv420p", paths["video"]], check=True)
    # "Speech": a modulated tone with pauses, at a quiet level.
    subprocess.run(quiet + ["-f", "lavfi", "-i", "sine=f=220:d=5", "-af",
                            "volume='if(lt(mod(t,1),0.7),0.15,0)':eval=frame", "-ar", "24000", "-ac", "1",
                            paths["voice"]], check=True)
    subprocess.run(quiet + ["-f", "lavfi", "-i", "sine=f=330:d=12", "-f", "lavfi", "-i", "sine=f=495:d=12",
                            "-filter_complex", "[0][1]amix=inputs=2,volume=0.6", "-ar", "48000", "-ac", "2",
                            paths["music"]], check=True)
    return paths


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg not installed")
class RenderTests(unittest.TestCase):
    def test_master_music_loudness_and_loop_length(self):
        with tempfile.TemporaryDirectory() as work:
            media = make_media(work)
            result = mix.master_music(media["music"], work, duration=6.0, loopable=True)
            self.assertAlmostEqual(result["durationSeconds"], 6.0, delta=0.05)
            self.assertAlmostEqual(result["lufs"], -16.0, delta=1.0)
            self.assertLessEqual(result["truePeak"], -1.0)
            self.assertTrue(os.path.getsize(result["mp3"]) > 0 and os.path.getsize(result["waveform"]) > 0)

    def test_finish_end_to_end(self):
        store = FakeStore()
        library = lib.Library(store)
        with tempfile.TemporaryDirectory() as work:
            media = make_media(work)
            with open(media["video"], "rb") as handle:
                store.put(f"{DAY}/vid000000001/video-01.mp4", handle.read(), "video/mp4")
            store.put(f"{DAY}/vid000000001/poster-01.jpg", jpeg(), "image/jpeg")
            library.record({"jobId": "vid000000001", "owner": OWNER, "createdAt": "2026-10-01T10:00:00+00:00",
                            "kind": "video", "request": {"prompt": "test card", "model": "video-quality"},
                            "videos": [{"variant": 1, "width": 640, "height": 360, "fps": 24,
                                        "durationSeconds": 4.0, "mode": "text-to-video"}]},
                           tenant_dir=f"{DAY}/vid000000001")
            files = {"aud000000001": media["voice"], "mus000000001": media["music"]}
            for ref_id, seconds in (("aud000000001", 5.0), ("mus000000001", 12.0)):
                reference = audio_reference(ref_id, seconds=seconds)
                with open(files[ref_id], "rb") as handle:
                    store.put(reference.key, handle.read(), "audio/wav")

            def fake_upload(key, body, content_type, expires_at):
                store.put(key, body, content_type)

            def fake_reference_bytes(reference_id, owner):
                with open(files[reference_id], "rb") as handle:
                    return handle.read()

            with mock.patch.object(main, "library", library), \
                    mock.patch.object(main, "upload", fake_upload), \
                    mock.patch.object(main, "reference_bytes", fake_reference_bytes), \
                    mock.patch.object(main, "write_stats", lambda *a, **k: None):
                async def scenario():
                    job = await main.finish_video(main.FinishRequest(
                        video={"itemId": "vid000000001", "take": 0},
                        music={"audioId": "mus000000001"},
                        narration=[{"audioId": "aud000000001", "text": "A test line that runs past the clip.",
                                    "voice": "en_US-heart-local"}],
                        captions=True, levels="balanced", title="E2E"), x_burtson_owner=OWNER, idempotency_key=None)
                    finished = main.jobs[job["id"]]
                    worker = asyncio.create_task(main.run_finish_queue())
                    await asyncio.wait_for(main.finish_queue.join(), timeout=60)
                    await asyncio.sleep(0.2)
                    worker.cancel()
                    return finished
                finished = asyncio.run(scenario())
            self.assertEqual(finished.status, "completed", finished.error)
            video = finished.videos[0]
            # 0.5 s lead + 5 s line + 0.6 s tail: the 4 s clip is held to fit the narration.
            self.assertAlmostEqual(video["durationSeconds"], 6.1, delta=0.15)
            self.assertAlmostEqual(video["mix"]["lufs"], -16.0, delta=1.5)
            self.assertLessEqual(video["mix"]["truePeak"], -1.0)
            self.assertEqual(video["mix"]["captions"], 1)
            self.assertFalse(video["mix"]["videoCopied"])
            item = library.get_item(OWNER, finished.id)
            self.assertEqual((item["kind"], item["mode"]), ("video", "finished"))
            self.assertIn("narration-01", item["inputs"])
            self.assertIn("music", item["inputs"])
            out = os.path.join(work, "out.mp4")
            with open(out, "wb") as handle:
                handle.write(library.read_file(OWNER, finished.id, "video-01.mp4")[0])
            probe = mix.probe_media(out)
            self.assertEqual(probe["audio"]["channels"], 2)
            self.assertEqual(probe["audio"]["sampleRate"], 48000)
            self.assertEqual((probe["video"]["width"], probe["video"]["height"]), (640, 360))
        clear_state()


if __name__ == "__main__":
    unittest.main()
