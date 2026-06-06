"""Tests for core.transcription — extract_audio (ffmpeg) and transcribe (Deepgram).

Everything external is mocked: subprocess.run for ffmpeg, httpx.post for
Deepgram. No network, no real ffmpeg binary, deterministic.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import core.transcription as tr
from core.exceptions import NonRetryablePlatformError


class _FakeResp:
    """Minimal httpx.Response stand-in for the bits _deepgram_request reads."""

    def __init__(self, status_code=200, body=None, text="", headers=None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.text = text
        self.headers = headers or {}

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self):
        return self._body


def _good_deepgram_body(transcript: str) -> dict:
    """A well-formed Deepgram prerecorded response carrying `transcript`."""
    return {
        "results": {
            "channels": [{"alternatives": [{"transcript": transcript}]}]
        }
    }


# ── extract_audio (ffmpeg) ───────────────────────────────────────────────


def test_extract_audio_raises_on_ffmpeg_nonzero_exit(monkeypatch):
    monkeypatch.setattr(tr, "get_signed_url", lambda sp: "https://signed/x.mp4")
    monkeypatch.setattr(tr, "_ffmpeg_exe", lambda: "ffmpeg")
    monkeypatch.setattr(
        tr.subprocess, "run",
        lambda *a, **k: SimpleNamespace(returncode=1, stderr="bad input\nfatal"),
    )

    with pytest.raises(RuntimeError, match="ffmpeg audio extraction failed"):
        tr.extract_audio("tiktok/manual/u1/x.mp4")


def test_extract_audio_includes_protocol_whitelist(monkeypatch):
    # The signed-URL hardening (finding #4): ffmpeg must be pinned to a known
    # protocol allow-list so a malicious input can't coax it into other schemes.
    captured: dict = {}
    monkeypatch.setattr(tr, "get_signed_url", lambda sp: "https://signed/x.mp4")
    monkeypatch.setattr(tr, "_ffmpeg_exe", lambda: "ffmpeg")

    def fake_run(cmd, **k):
        captured["cmd"] = cmd
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(tr.subprocess, "run", fake_run)

    tr.extract_audio("tiktok/manual/u1/x.mp4")

    cmd = captured["cmd"]
    assert "-protocol_whitelist" in cmd
    assert cmd[cmd.index("-protocol_whitelist") + 1] == "file,http,https,tcp,tls"


# ── transcribe (Deepgram) ────────────────────────────────────────────────


def test_transcribe_missing_key_raises(monkeypatch, tmp_path):
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    mp3 = tmp_path / "a.mp3"
    mp3.write_bytes(b"audio")
    with pytest.raises(RuntimeError, match="DEEPGRAM_API_KEY"):
        tr.transcribe(str(mp3))


def test_transcribe_non_200_raises_without_retry(monkeypatch, tmp_path):
    # A 400 is a client error → NonRetryablePlatformError, raised immediately
    # (no backoff sleeps). raise_for_retryable_status maps the status.
    monkeypatch.setenv("DEEPGRAM_API_KEY", "k")
    mp3 = tmp_path / "a.mp3"
    mp3.write_bytes(b"audio")
    monkeypatch.setattr(
        tr.httpx, "post",
        lambda *a, **k: _FakeResp(status_code=400, text="bad request"),
    )
    with pytest.raises(NonRetryablePlatformError):
        tr.transcribe(str(mp3))


def test_transcribe_empty_transcript_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "k")
    mp3 = tmp_path / "a.mp3"
    mp3.write_bytes(b"audio")
    monkeypatch.setattr(
        tr.httpx, "post",
        lambda *a, **k: _FakeResp(body=_good_deepgram_body("")),
    )
    with pytest.raises(RuntimeError, match="empty transcript"):
        tr.transcribe(str(mp3))


def test_transcribe_malformed_shape_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "k")
    mp3 = tmp_path / "a.mp3"
    mp3.write_bytes(b"audio")
    monkeypatch.setattr(
        tr.httpx, "post",
        lambda *a, **k: _FakeResp(body={"results": {"channels": []}}),
    )
    with pytest.raises(RuntimeError, match="Unexpected Deepgram response shape"):
        tr.transcribe(str(mp3))


def test_transcribe_happy_path(monkeypatch, tmp_path):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "k")
    mp3 = tmp_path / "a.mp3"
    mp3.write_bytes(b"audio")
    monkeypatch.setattr(
        tr.httpx, "post",
        lambda *a, **k: _FakeResp(body=_good_deepgram_body("hello world")),
    )
    assert tr.transcribe(str(mp3)) == "hello world"
