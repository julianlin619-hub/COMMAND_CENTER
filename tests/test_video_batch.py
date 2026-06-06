"""Tests for core.video_batch — fan-out shape, per-leg idempotency, the
orchestration-level double-publish guard (claim-before-work), and main().

All external calls (DB, Buffer, ffmpeg/Deepgram, the LLM) are monkeypatched in
the core.video_batch namespace so nothing external is touched.
"""

from __future__ import annotations

import json

import pytest

import core.video_batch as vb
from core.models import Post


class _Recorder:
    """Captures inserted posts, buffer sends, handoffs, and deletes.

    insert_post returns ids of the form ``post-<platform>-<n>`` so a test can
    assert WHICH leg's row was rolled back without hardcoding insertion order
    (finding #18).
    """

    def __init__(self):
        self.inserted: list[Post] = []
        self.sends: list[dict] = []
        self.handoffs: list[dict] = []
        self.deleted: list[str] = []
        self.id_to_platform: dict[str, str] = {}
        self.platform_to_id: dict[str, str] = {}
        self._next = 0

    def insert_post(self, post: Post) -> str:
        self._next += 1
        post_id = f"post-{post.platform}-{self._next}"
        self.inserted.append(post)
        self.id_to_platform[post_id] = post.platform
        self.platform_to_id[post.platform] = post_id
        return post_id

    def send_to_buffer(self, channel_id, caption, media_url, media_type="video",
                       youtube=None, caption_limit=None):
        self.sends.append({
            "channel_id": channel_id,
            "caption": caption,
            "media_url": media_url,
            "youtube": youtube,
            "caption_limit": caption_limit,
        })
        return f"buffer-{len(self.sends)}"

    def record_buffer_handoff(self, post_id, buffer_post_id, **kwargs):
        self.handoffs.append({"post_id": post_id, "buffer_post_id": buffer_post_id, **kwargs})


def _patch(monkeypatch, rec: _Recorder, *, fail_services: set[str] | None = None,
           already: dict[str, str] | None = None):
    """Wire core.video_batch's deps to the recorder.

    fail_services: set of Buffer *service* names whose send_to_buffer raises
        (e.g. {"tiktok"}, {"twitter"} for the X leg, {"youtube", "twitter"}).
    already: map of platform -> existing buffer id, simulating a re-run where
        that leg was already posted (_already_posted returns it).
    """
    fail_services = fail_services or set()
    already = already or {}

    monkeypatch.setattr(vb, "insert_post", rec.insert_post)
    monkeypatch.setattr(vb, "record_buffer_handoff", rec.record_buffer_handoff)
    monkeypatch.setattr(vb, "build_proxy_url", lambda pid: f"proxy/{pid}")
    monkeypatch.setattr(vb, "_delete_post", lambda pid: rec.deleted.append(pid))
    monkeypatch.setattr(vb, "_already_posted", lambda job_id, platform: already.get(platform))

    monkeypatch.setattr(vb, "get_channel_id",
                        lambda service="tiktok", name=None: f"chan-{service}")

    def fake_send(channel_id, caption, media_url, media_type="video",
                  youtube=None, caption_limit=None):
        for svc in fail_services:
            if channel_id == f"chan-{svc}":
                raise RuntimeError(f"{svc} boom")
        return rec.send_to_buffer(
            channel_id, caption, media_url, media_type,
            youtube=youtube, caption_limit=caption_limit,
        )

    monkeypatch.setattr(vb, "send_to_buffer", fake_send)


# ── fan-out shape + caption limits ───────────────────────────────────────


def test_fanout_inserts_three_legs_with_manual_upload_shape(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, rec)

    result = vb.fanout_video("job1", "tiktok/manual/u1/abc.mp4", "A Title", "A caption")

    platforms = [p.platform for p in rec.inserted]
    assert platforms == ["tiktok", "youtube", "x_acq_official"]
    for post in rec.inserted:
        assert post.status == "sent_to_buffer"
        assert post.media_type == "video"
        assert post.media_urls == ["tiktok/manual/u1/abc.mp4"]
        assert post.title == "A Title"
        assert post.caption == "A caption"
        assert post.metadata["source"] == "manual_upload"
        assert post.metadata["storage_cleanup_status"] == "pending"
        # The job id links the leg back to its job for idempotency (finding #2).
        assert post.metadata["video_batch_job_id"] == "job1"

    assert result["tiktok_buffer_id"] == "buffer-1"
    assert result["youtube_buffer_id"] == "buffer-2"
    assert result["x_buffer_id"] == "buffer-3"


def test_fanout_records_handoff_with_replay_payload(monkeypatch):
    # Finding #5: legs go through record_buffer_handoff (not a bare stamp), and
    # the YouTube/X replay carries the metadata + caption_limit a re-send needs.
    rec = _Recorder()
    _patch(monkeypatch, rec)

    vb.fanout_video("job1", "tiktok/manual/u1/abc.mp4", "My Title", "cap")

    by_chan = {h["channel_id"]: h for h in rec.handoffs}
    # TikTok: no youtube block, default caption limit (None → reconcile uses 150).
    assert by_chan["chan-tiktok"]["youtube"] is None
    assert by_chan["chan-tiktok"]["caption_limit"] is None
    assert by_chan["chan-tiktok"]["body"] == "cap"
    # YouTube: title block + 5000 limit so a re-send isn't rejected/truncated.
    assert by_chan["chan-youtube"]["youtube"]["title"] == "My Title"
    assert by_chan["chan-youtube"]["caption_limit"] == vb._YOUTUBE_CAPTION_LIMIT
    # X: 280 limit, no youtube block.
    assert by_chan["chan-twitter"]["youtube"] is None
    assert by_chan["chan-twitter"]["caption_limit"] == vb._X_CAPTION_LIMIT


def test_fanout_applies_caption_limits_and_youtube_metadata(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, rec)

    vb.fanout_video("job1", "tiktok/manual/u1/abc.mp4", "My Title", "cap")

    tiktok, youtube, x = rec.sends
    assert tiktok["caption_limit"] is None
    assert tiktok["youtube"] is None
    assert youtube["caption_limit"] == vb._YOUTUBE_CAPTION_LIMIT
    assert youtube["youtube"]["title"] == "My Title"
    assert youtube["youtube"]["categoryId"] == "27"
    assert x["caption_limit"] == vb._X_CAPTION_LIMIT
    assert x["youtube"] is None


# ── per-leg failure / rollback (finding #10, #18) ────────────────────────


def test_tiktok_failure_raises_and_rolls_back_its_row(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, rec, fail_services={"tiktok"})
    # TikTok is the primary leg — its failure must propagate so the job fails,
    # and its inserted row must be rolled back (finding #10).
    with pytest.raises(RuntimeError, match="tiktok boom"):
        vb.fanout_video("job1", "tiktok/manual/u1/abc.mp4", "T", "c")
    assert rec.deleted == [rec.platform_to_id["tiktok"]]


def test_youtube_failure_is_partial_success(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, rec, fail_services={"youtube"})

    result = vb.fanout_video("job1", "tiktok/manual/u1/abc.mp4", "T", "c")

    assert result["tiktok_buffer_id"]
    assert "youtube_error" in result
    assert "x_buffer_id" in result
    # Assert the YOUTUBE leg's row was the one deleted — by platform, not order.
    assert rec.deleted == [rec.platform_to_id["youtube"]]


def test_x_failure_is_partial_success(monkeypatch):
    # The X leg failing is best-effort too (finding #18: previously untested).
    rec = _Recorder()
    _patch(monkeypatch, rec, fail_services={"twitter"})

    result = vb.fanout_video("job1", "tiktok/manual/u1/abc.mp4", "T", "c")

    assert result["tiktok_buffer_id"]
    assert result["youtube_buffer_id"]
    assert "x_error" in result
    assert rec.deleted == [rec.platform_to_id["x_acq_official"]]


def test_both_best_effort_legs_fail(monkeypatch):
    # Both YouTube AND X fail; TikTok still succeeds. Both rolled-back rows are
    # the YT and X rows specifically (finding #18 double-failure case).
    rec = _Recorder()
    _patch(monkeypatch, rec, fail_services={"youtube", "twitter"})

    result = vb.fanout_video("job1", "tiktok/manual/u1/abc.mp4", "T", "c")

    assert result["tiktok_buffer_id"]
    assert "youtube_error" in result
    assert "x_error" in result
    assert set(rec.deleted) == {
        rec.platform_to_id["youtube"], rec.platform_to_id["x_acq_official"]
    }


# ── per-leg idempotency on re-run (finding #2 / #17b) ────────────────────


def test_rerun_skips_already_posted_leg(monkeypatch):
    # Simulate a crash-and-rerun where TikTok was already queued: _already_posted
    # returns its buffer id, so the TikTok leg must NOT be re-inserted or re-sent
    # (no double-post), while YT + X still go out.
    rec = _Recorder()
    _patch(monkeypatch, rec, already={"tiktok": "buffer-old-tt"})

    result = vb.fanout_video("job1", "tiktok/manual/u1/abc.mp4", "T", "c")

    # TikTok reused the existing id; only YT + X were inserted/sent.
    assert result["tiktok_buffer_id"] == "buffer-old-tt"
    inserted_platforms = [p.platform for p in rec.inserted]
    assert "tiktok" not in inserted_platforms
    assert inserted_platforms == ["youtube", "x_acq_official"]
    sent_channels = [s["channel_id"] for s in rec.sends]
    assert "chan-tiktok" not in sent_channels


# ── process_job orchestration (finding #17) ──────────────────────────────


def _patch_pipeline(monkeypatch, *, claimed=True, fanout_result=None,
                    transcribe_exc=None):
    """Stub the per-job pipeline around process_job. Returns captured updates."""
    monkeypatch.setattr(vb, "claim_video_batch_job", lambda job_id: claimed)
    monkeypatch.setattr(vb, "get_video_batch_job",
                        lambda job_id: {"storage_path": "p/x.mp4", "status": "processing"})
    monkeypatch.setattr(vb, "extract_audio", lambda sp: "/tmp/x.mp3")

    def fake_transcribe(mp3):
        if transcribe_exc:
            raise transcribe_exc
        return "a transcript"

    monkeypatch.setattr(vb, "transcribe", fake_transcribe)
    monkeypatch.setattr(vb, "generate_title", lambda t: "Generated Title")
    monkeypatch.setattr(vb, "pick_caption", lambda t: "a caption")

    fanout_calls: list[tuple] = []

    def fake_fanout(job_id, storage_path, title, caption):
        fanout_calls.append((job_id, storage_path, title, caption))
        return fanout_result if fanout_result is not None else {"tiktok_buffer_id": "b1"}

    monkeypatch.setattr(vb, "fanout_video", fake_fanout)

    updates: list[dict] = []
    monkeypatch.setattr(vb, "update_video_batch_job",
                        lambda job_id, **f: updates.append({"job_id": job_id, **f}))

    # Pretend the temp mp3 exists so the finally-cleanup path runs.
    removed: list[str] = []
    monkeypatch.setattr(vb.os.path, "exists", lambda p: True)
    monkeypatch.setattr(vb.os, "remove", lambda p: removed.append(p))

    return {"fanout_calls": fanout_calls, "updates": updates, "removed": removed}


def test_process_job_lost_claim_skips_and_never_fans_out(monkeypatch):
    # Finding #17a: the orchestration-level double-publish guard. A lost claim
    # means another worker owns the job — fanout must NEVER be called.
    cap = _patch_pipeline(monkeypatch, claimed=False)

    result = vb.process_job("job1")

    assert result["skipped"] is True
    assert result["status"] == "processing"
    assert cap["fanout_calls"] == []  # fanout NEVER called


def test_process_job_happy_path_marks_done(monkeypatch):
    # Finding #17c.
    cap = _patch_pipeline(monkeypatch, fanout_result={"tiktok_buffer_id": "b1",
                                                      "youtube_buffer_id": "b2",
                                                      "x_buffer_id": "b3"})

    result = vb.process_job("job1")

    assert result["status"] == "done"
    assert result["title"] == "Generated Title"
    assert result["caption"] == "a caption"
    done = cap["updates"][0]
    assert done["status"] == "done"
    assert done["title"] == "Generated Title"
    assert done["caption"] == "a caption"
    assert done["transcript"] == "a transcript"


def test_process_job_partial_marks_done_partial(monkeypatch):
    # Finding #11: a best-effort leg failure → status done_partial.
    cap = _patch_pipeline(monkeypatch, fanout_result={"tiktok_buffer_id": "b1",
                                                      "youtube_error": "yt boom"})

    result = vb.process_job("job1")

    assert result["status"] == "done_partial"
    assert cap["updates"][0]["status"] == "done_partial"


def test_process_job_done_write_failure_does_not_flip_to_failed(monkeypatch):
    # Finding #2: a DB blip on the terminal write must not raise out of
    # process_job (which would let main() mark a fanned-out job failed).
    _patch_pipeline(monkeypatch)
    monkeypatch.setattr(
        vb, "update_video_batch_job",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db blip")),
    )

    result = vb.process_job("job1")  # must not raise

    assert result["status"] == "done"


def test_process_job_always_removes_temp_mp3_on_exception(monkeypatch):
    # Finding #17d: the finally-cleanup runs even when a mid-pipeline step
    # raises (here transcribe).
    cap = _patch_pipeline(monkeypatch, transcribe_exc=RuntimeError("deepgram down"))

    with pytest.raises(RuntimeError, match="deepgram down"):
        vb.process_job("job1")

    assert cap["removed"] == ["/tmp/x.mp3"]


# ── main() (finding #17e) ────────────────────────────────────────────────


def test_main_exception_marks_failed_prints_json_and_exits_1(monkeypatch, capsys):
    monkeypatch.setattr(vb, "install_log_sanitizer", lambda: None)
    monkeypatch.setattr(vb.sys, "argv", ["video_batch", "--job-id", "job1"])
    monkeypatch.setattr(vb, "process_job",
                        lambda job_id: (_ for _ in ()).throw(RuntimeError("kaboom")))

    failed: list[dict] = []
    monkeypatch.setattr(vb, "update_video_batch_job",
                        lambda job_id, **f: failed.append({"job_id": job_id, **f}))

    with pytest.raises(SystemExit) as exc:
        vb.main()
    assert exc.value.code == 1

    # Marked the row failed (best-effort) and printed a machine-readable line.
    assert failed and failed[0]["status"] == "failed"
    out = capsys.readouterr().out.strip().splitlines()[-1]
    parsed = json.loads(out)
    assert parsed["status"] == "failed"
    assert parsed["job_id"] == "job1"


def test_main_failed_mark_failure_is_swallowed(monkeypatch, capsys):
    # Even if marking the row failed ALSO fails (zero-row guard / DB down), main
    # must still print the JSON failure line and exit 1, not crash — the
    # except/failure-path wrap from finding #9.
    monkeypatch.setattr(vb, "install_log_sanitizer", lambda: None)
    monkeypatch.setattr(vb.sys, "argv", ["video_batch", "--job-id", "job1"])
    monkeypatch.setattr(vb, "process_job",
                        lambda job_id: (_ for _ in ()).throw(RuntimeError("kaboom")))
    monkeypatch.setattr(
        vb, "update_video_batch_job",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("row missing")),
    )

    with pytest.raises(SystemExit) as exc:
        vb.main()
    assert exc.value.code == 1
    parsed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert parsed["status"] == "failed"
