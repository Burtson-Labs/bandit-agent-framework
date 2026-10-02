"""Songs: timed lyrics (alignment, LRC, the stt-api call), clean endings (level
envelope end detection, rendered with ffmpeg when it is installed) and the lyrics
that reach History and watch."""
import asyncio
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import numpy as np

from app import audio_workflows as aw
from app import library as lib
from app import lyrics as lyr
from app import main
from app import mix
from app import watch_sync as ws

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None

SONG = """[Intro]

[Verse 1]
Static on the radio
Basement light is burning low

[Chorus]
And I'm fine, I'm fine
Counting cracks along the ceiling line

[Verse 2]
Flannel sleeves and borrowed tapes
Summer rain on empty streets

[Chorus]
And I'm fine, I'm fine
Counting cracks along the ceiling line

[Outro]
Static on the radio"""


def heard(lines, start=10.0, gap=0.4, line_gap=2.0, drop=(), swap=None, extra=()):
    """Fake whisper words for the given lines: drop word indexes, swap {index: word}, extra words appended."""
    words, t, n = [], start, 0
    for line in lines:
        for token in line.split():
            if n not in drop:
                words.append({"word": " " + (swap or {}).get(n, token), "start": round(t, 2), "end": round(t + gap * 0.8, 2)})
            n += 1
            t += gap
        t += line_gap
    for token in extra:
        words.append({"word": " " + token, "start": round(t, 2), "end": round(t + 0.3, 2)})
        t += gap
    return words


class SungLinesTests(unittest.TestCase):
    def test_lines_sections_and_outro(self):
        lines = lyr.sung_lines(SONG)
        self.assertEqual(lines[0], "Static on the radio")
        self.assertEqual(len(lines), 9)
        self.assertNotIn("[Chorus]", lines)
        self.assertEqual(lyr.sections(SONG)[0], "intro")
        self.assertEqual(lyr.ensure_outro(SONG), SONG)
        self.assertTrue(lyr.ensure_outro("[Verse]\nhey").endswith("[Outro]"))

    def test_tokens_ignore_case_and_apostrophes(self):
        self.assertEqual(lyr.tokens("And I'm fine, I'm FINE"), ["and", "im", "fine", "im", "fine"])


class AlignTests(unittest.TestCase):
    def test_clean_transcript_times_every_line(self):
        lines = lyr.sung_lines(SONG)
        timed = lyr.align(lines, heard(lines))
        self.assertEqual([line["text"] for line in timed], lines)
        self.assertEqual(timed[0]["t"], 10.0)
        starts = [line["t"] for line in timed]
        self.assertEqual(starts, sorted(starts))
        for line in timed:
            self.assertLessEqual(line["t"], line["end"])

    def test_misheard_and_dropped_words_keep_the_timing(self):
        lines = lyr.sung_lines(SONG)
        clean = lyr.align(lines, heard(lines))
        noisy = lyr.align(lines, heard(lines, drop={1, 2, 9, 30}, swap={4: "radios", 12: "fyne", 20: "seeling"}))
        for a, b in zip(clean, noisy):
            self.assertLess(abs(a["t"] - b["t"]), 1.0, (a, b))

    def test_repeated_chorus_maps_in_order(self):
        lines = lyr.sung_lines(SONG)
        timed = lyr.align(lines, heard(lines))
        first, second = timed[2]["t"], timed[6]["t"]   # both "And I'm fine, I'm fine"
        self.assertLess(first + 10, second)

    def test_a_line_whisper_missed_is_interpolated(self):
        lines = lyr.sung_lines(SONG)
        words = heard(lines)
        n_before = sum(len(line.split()) for line in lines[:4])
        missing = set(range(n_before, n_before + len(lines[4].split())))   # verse 2, line 1 entirely
        timed = lyr.align(lines, [w for i, w in enumerate(words) if i not in missing])
        self.assertGreater(timed[4]["t"], timed[3]["t"])
        self.assertLessEqual(timed[4]["t"], timed[5]["t"])

    def test_leading_ad_libs_do_not_pull_the_first_line_early(self):
        lines = lyr.sung_lines(SONG)
        words = [{"word": " yeah", "start": 3.0, "end": 3.3}, {"word": " uh", "start": 4.0, "end": 4.2}] + heard(lines)
        timed = lyr.align(lines, words)
        self.assertEqual(timed[0]["t"], 10.0)

    def test_untrustworthy_transcripts_give_none(self):
        lines = lyr.sung_lines(SONG)
        self.assertIsNone(lyr.align(lines, []))
        self.assertIsNone(lyr.align(lines, [{"word": " la", "start": 1, "end": 2}] * 40))
        self.assertIsNone(lyr.align([], heard(["a b"])))

    def test_lrc(self):
        text = lyr.to_lrc([{"t": 0, "end": 1, "text": "a"}, {"t": 65.432, "end": None, "text": "b"}], title="Song")
        self.assertEqual(text, "[ti:Song]\n[00:00.00]a\n[01:05.43]b\n")

    def test_words_from_transcript(self):
        body = {"segments": [{"words": [{"word": "a"}]}, {"words": [{"word": "b"}]}, {}]}
        self.assertEqual([w["word"] for w in lyr.words_from_transcript(body)], ["a", "b"])


class EndingTests(unittest.TestCase):
    window = mix.ENVELOPE_WINDOW

    def levels(self, loud_until, total, decay=0.0):
        n = int(total / self.window)
        out = []
        for i in range(n):
            t = i * self.window
            if t < loud_until:
                out.append(-14.0 + (0.5 if i % 7 else 0.0))
            elif t < loud_until + decay:
                out.append(-14.0 - 40.0 * (t - loud_until) / decay)
            else:
                out.append(-80.0)
        return np.array(out)

    def test_natural_decay_inside_the_window_ends_there(self):
        end, fade, natural = mix.find_ending(self.levels(150.0, 186.0, decay=3.0), window=self.window,
                                             earliest=126.0, latest=186.0)
        self.assertTrue(natural)
        self.assertAlmostEqual(end, 150.0 + 20 / 40 * 3 + mix.ENDING_RELEASE, delta=0.2)
        self.assertGreaterEqual(end - fade, 150.0)        # the fade never starts inside the music

    def test_still_playing_at_the_end_fades_out(self):
        end, fade, natural = mix.find_ending(self.levels(200.0, 186.0), window=self.window,
                                             earliest=126.0, latest=186.0)
        self.assertFalse(natural)
        self.assertEqual((end, fade), (186.0, mix.ENDING_FADE))

    def test_bed_never_runs_past_its_length(self):
        end, _, _ = mix.find_ending(self.levels(60.0, 60.0), window=self.window, earliest=57.0, latest=60.0)
        self.assertEqual(end, 60.0)
        end, _, natural = mix.find_ending(self.levels(58.0, 60.0, decay=0.5), window=self.window,
                                          earliest=57.0, latest=60.0)
        self.assertTrue(natural)
        self.assertLessEqual(end, 60.0)

    def test_music_that_stopped_too_early_ends_at_the_earliest(self):
        end, _, natural = mix.find_ending(self.levels(30.0, 186.0), window=self.window, earliest=126.0, latest=186.0)
        self.assertEqual((end, natural), (126.0, False))

    def test_silence_fades_at_latest(self):
        self.assertEqual(mix.find_ending(np.full(100, -120.0), window=self.window, earliest=1, latest=5)[0], 5.0)

    def test_envelope(self):
        sr = mix.ENVELOPE_RATE
        signal = np.concatenate([0.5 * np.sin(np.linspace(0, 2000, sr)), np.zeros(sr)]).astype(np.float32)
        env = mix.level_envelope(signal)
        self.assertEqual(len(env), 40)
        self.assertGreater(env[5], -12)
        self.assertLess(env[-1], -100)


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg not installed")
class EndingRenderTests(unittest.TestCase):
    def render(self, work, expr, seconds):
        path = os.path.join(work, "raw.wav")
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        f"aevalsrc='{expr}':s=48000:d={seconds}", "-ac", "2", path], check=True)
        return path

    def test_natural_decay_is_kept_and_the_tail_trimmed(self):
        with tempfile.TemporaryDirectory() as work:
            raw = self.render(work, "if(lt(t,20),0.4*sin(2*PI*220*t),0.4*sin(2*PI*220*t)*exp(-3*(t-20)))", 30)
            result = mix.master_music(raw, work, duration=24, loopable=False, ending=(16.8, 30))
            self.assertTrue(result["naturalEnding"])
            self.assertLess(result["durationSeconds"], 24.5)
            self.assertGreater(result["durationSeconds"], 20.5)

    def test_abrupt_take_gets_a_fade_at_the_edge(self):
        with tempfile.TemporaryDirectory() as work:
            raw = self.render(work, "0.4*sin(2*PI*220*t)", 30)
            result = mix.master_music(raw, work, duration=24, loopable=False, ending=(16.8, 30))
            self.assertFalse(result["naturalEnding"])
            self.assertAlmostEqual(result["durationSeconds"], 30, delta=0.1)
            tail = mix.measure(result["wav"], start=29.6, duration=0.4)
            body = mix.measure(result["wav"], start=10, duration=5)
            self.assertLess(tail["lufs"], body["lufs"] - 10)


class TimeLyricsTests(unittest.TestCase):
    def plan(self):
        return aw.plan_music(prompt="90s alternative", seed=1, duration_seconds=None, instrumental=False, lyrics=SONG)

    def test_no_service_key_completes_without_timing(self):
        with mock.patch.object(main, "STT_SERVICE_KEY", ""):
            out = asyncio.run(main.time_lyrics(b"mp3", self.plan(), "en"))
        self.assertEqual(out, {"text": self.plan().lyrics, "lines": None, "source": "none"})

    def fake_client(self, status=200, body=None, exc=None):
        calls = []

        class Response:
            status_code = status

            def json(self):
                return body

        class Client:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def post(self, url, **kwargs):
                calls.append((url, kwargs))
                if exc:
                    raise exc
                return Response()

        return Client, calls

    def test_aligned_lines_from_stt_api(self):
        plan = self.plan()
        lines = lyr.sung_lines(plan.lyrics)
        client, calls = self.fake_client(body={"text": "...", "segments": [{"words": heard(lines)}]})
        with mock.patch.object(main, "STT_SERVICE_KEY", "k" * 32), mock.patch.object(main.httpx, "AsyncClient", client):
            out = asyncio.run(main.time_lyrics(b"mp3", plan, "en"))
        self.assertEqual(out["source"], "aligned")
        self.assertEqual(len(out["lines"]), len(lines))
        url, kwargs = calls[0]
        self.assertTrue(url.endswith("/api/transcribe"))
        self.assertEqual(kwargs["headers"], {"X-Stt-Service-Key": "k" * 32})
        self.assertEqual(kwargs["data"]["word_timestamps"], "true")
        self.assertIn("Static on the radio", kwargs["data"]["initial_prompt"])

    def test_stt_failures_never_fail_the_song(self):
        for client, _ in (self.fake_client(status=500), self.fake_client(exc=RuntimeError("down")),
                          self.fake_client(body={"segments": []})):
            with mock.patch.object(main, "STT_SERVICE_KEY", "k" * 32), mock.patch.object(main.httpx, "AsyncClient", client):
                out = asyncio.run(main.time_lyrics(b"mp3", self.plan(), "en"))
            self.assertEqual((out["lines"], out["source"]), (None, "none"))


class SongJobTests(unittest.TestCase):
    def tearDown(self):
        main.jobs.clear()
        while not main.queue.empty():
            main.queue.get_nowait()
            main.queue.task_done()

    def test_song_take_carries_lyrics_and_an_lrc_asset(self):
        request = main.MusicRequest(prompt="90s alternative rock", instrumental=False, lyrics=SONG, title="Static")
        job = main.create_music_job(request, "user-1")
        self.assertTrue(job.request["plan"]["durationDerived"])
        self.assertEqual(job.request["durationSeconds"], job.request["plan"]["durationSeconds"])
        self.assertIn("lyricsSeconds", job.request["estimate"])
        uploads = []
        timed = [{"t": 1.0, "end": 2.0, "text": "Static on the radio"}]

        async def lyrics(audio, plan, language):
            return {"text": plan.lyrics, "lines": timed, "source": "aligned"}

        def master(raw, plan):
            return {"lufs": -16.0, "truePeak": -1.5, "durationSeconds": 150.0, "sampleRate": 48000, "channels": 2,
                    "wavBytes": b"wav", "mp3Bytes": b"mp3", "waveBytes": b"jpg", "naturalEnding": True}

        with mock.patch.object(main, "wait_for_worker", mock.AsyncMock(return_value=True)), \
                mock.patch.object(main, "run_music_prompt", mock.AsyncMock(return_value=b"raw")), \
                mock.patch.object(main, "master_music_bytes", master), \
                mock.patch.object(main, "time_lyrics", lyrics), \
                mock.patch.object(main, "upload", lambda key, body, ct, exp: uploads.append((key, body, ct))), \
                mock.patch.object(main, "record_music_timing"):
            asyncio.run(main.execute_music(job))
        self.assertEqual(job.status, "completed")
        take = job.audios[0]
        self.assertEqual(take["lyrics"]["lines"], timed)
        self.assertTrue(take["naturalEnding"])
        self.assertTrue(take["lrcUrl"].endswith("/assets/3"))
        lrc = [u for u in uploads if u[0].endswith("lyrics-01.lrc")][0]
        self.assertEqual(lrc[1], b"[ti:Static]\n[00:01.00]Static on the radio\n")
        self.assertTrue(lrc[2].startswith("text/plain"))

    def test_estimate_route_derives_a_song_length(self):
        out = asyncio.run(main.estimate_audio(main.MusicEstimateRequest(instrumental=False, lyrics=SONG, bpm=118)))
        self.assertTrue(out["valid"])
        self.assertTrue(out["durationDerived"])
        self.assertGreaterEqual(out["durationSeconds"], 60)
        self.assertIn("lyricsSeconds", out)
        bad = asyncio.run(main.estimate_audio(main.MusicEstimateRequest(instrumental=False, lyrics=SONG, loopable=True)))
        self.assertFalse(bad["valid"])


class SongHistoryTests(unittest.TestCase):
    def test_song_take_keeps_lyrics_and_lrc_in_history_and_watch(self):
        from tests.test_library import FakeStore, jpeg
        store, owner, day, job_id = FakeStore(), "user-123", "v1/tenant/user-123/2026/10/01", "song000000job"
        store.put(f"{day}/{job_id}/audio-01.wav", b"wav", "audio/wav")
        store.put(f"{day}/{job_id}/audio-01.mp3", b"mp3", "audio/mpeg")
        store.put(f"{day}/{job_id}/wave-01.jpg", jpeg(), "image/jpeg")
        store.put(f"{day}/{job_id}/lyrics-01.lrc", b"[00:01.00]hi\n", "text/plain; charset=utf-8")
        timed = {"text": SONG, "lines": [{"t": 1.0, "end": 2.0, "text": "hi"}], "source": "aligned"}
        library = lib.Library(store)
        item = library.record({
            "jobId": job_id, "owner": owner, "createdAt": "2026-10-01T10:00:00+00:00", "kind": "audio",
            "request": {"prompt": "rock", "instrumental": False, "lyrics": SONG, "title": "Static"},
            "audios": [{"variant": 1, "seed": 1, "durationSeconds": 150.0, "mode": "music", "instrumental": False,
                        "lyrics": timed, "naturalEnding": True}],
        }, tenant_dir=f"{day}/{job_id}")
        take = item["outputs"][0]
        self.assertEqual(take["lyrics"], timed)
        self.assertEqual(take["lrc"], "lyrics-01.lrc")
        self.assertTrue(take["naturalEnding"])
        self.assertEqual(library.read_file(owner, job_id, "lyrics-01.lrc"),
                         (b"[00:01.00]hi\n", "text/plain; charset=utf-8"))
        meta = ws.history_metadata(library.items_of(lib.safe_owner(owner))[0], take, "t")
        self.assertEqual(meta["lyrics"], {"text": SONG, "lines": timed["lines"]})

    def test_untimed_song_records_without_lrc(self):
        from tests.test_library import FakeStore, jpeg
        store, owner, day, job_id = FakeStore(), "user-123", "v1/tenant/user-123/2026/10/01", "song000001job"
        for name, ct in (("audio-01.wav", "audio/wav"), ("audio-01.mp3", "audio/mpeg")):
            store.put(f"{day}/{job_id}/{name}", b"x", ct)
        store.put(f"{day}/{job_id}/wave-01.jpg", jpeg(), "image/jpeg")
        item = lib.Library(store).record({
            "jobId": job_id, "owner": owner, "createdAt": "2026-10-01T10:00:00+00:00", "kind": "audio",
            "request": {"prompt": "rock", "instrumental": False, "lyrics": SONG},
            "audios": [{"variant": 1, "mode": "music", "instrumental": False,
                        "lyrics": {"text": SONG, "lines": None, "source": "none"}}],
        }, tenant_dir=f"{day}/{job_id}")
        self.assertNotIn("lrc", item["outputs"][0])
        self.assertEqual(item["outputs"][0]["lyrics"]["source"], "none")


class WatchLyricsTests(unittest.TestCase):
    def test_full_lyrics_go_to_watch(self):
        long_text = SONG + "\n" + "more words " * 100
        item = {"id": "job1", "owner": "user-1", "kind": "audio", "prompt": "rock",
                "request": {"prompt": "rock", "instrumental": False, "lyrics": long_text}, "outputs": []}
        timed = {"text": long_text, "lines": [{"t": 1.0, "end": 2.0, "text": "x"}], "source": "aligned"}
        output = {"index": 0, "variant": 1, "kind": "audio", "mode": "music", "lyrics": timed}
        meta = ws.history_metadata(item, output, "studio:job1:audio1")
        self.assertEqual(meta["lyrics"], {"text": long_text, "lines": timed["lines"]})
        untimed = ws.history_metadata(item, {"index": 0, "variant": 1, "kind": "audio"}, "t")
        self.assertEqual(untimed["lyrics"], {"text": long_text, "lines": None})
        bed = {**item, "request": {"prompt": "bed", "instrumental": True}}
        self.assertNotIn("lyrics", ws.history_metadata(bed, {"index": 0, "variant": 1, "kind": "audio"}, "t"))


if __name__ == "__main__":
    unittest.main()
