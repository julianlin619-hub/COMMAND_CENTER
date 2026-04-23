"""Tests for core.youtube_transcript — VTT parsing and transcript fetching."""

from __future__ import annotations

from dataclasses import dataclass

from core.exceptions import PlatformAPIError, PlatformAuthError
from core.youtube_transcript import (
    FetchedTranscript,
    _parse_vtt,
    _pick_track,
    fetch_transcript,
)


# ── _parse_vtt ───────────────────────────────────────────────────────────


class TestParseVtt:
    def test_empty_input(self):
        assert _parse_vtt("") == ""

    def test_header_stripped(self):
        vtt = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:02.000\nhello world\n"
        assert _parse_vtt(vtt) == "hello world"

    def test_numeric_cue_ids_dropped(self):
        vtt = (
            "WEBVTT\n\n"
            "1\n00:00:00.000 --> 00:00:02.000\nfirst cue\n\n"
            "2\n00:00:02.000 --> 00:00:04.000\nsecond cue\n"
        )
        assert _parse_vtt(vtt) == "first cue second cue"

    def test_multi_line_cue_joined(self):
        vtt = (
            "WEBVTT\n\n"
            "00:00:00.000 --> 00:00:03.000\n"
            "line one\n"
            "line two\n"
        )
        assert _parse_vtt(vtt) == "line one line two"

    def test_inline_tags_stripped(self):
        vtt = (
            "WEBVTT\n\n"
            "00:00:00.000 --> 00:00:02.000\n"
            "<c.colorE5E5E5>hello</c> <00:00:01.500><c>world</c>\n"
        )
        assert _parse_vtt(vtt) == "hello world"

    def test_italic_tag_stripped(self):
        vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<i>hello</i>\n"
        assert _parse_vtt(vtt) == "hello"

    def test_note_block_skipped(self):
        vtt = (
            "WEBVTT\n\n"
            "NOTE this is a producer comment\nthat spans lines\n\n"
            "00:00:00.000 --> 00:00:02.000\nreal line\n"
        )
        assert _parse_vtt(vtt) == "real line"

    def test_adjacent_duplicate_lines_deduped(self):
        # YouTube ASR emits rolling cues that repeat previous text.
        vtt = (
            "WEBVTT\n\n"
            "00:00:00.000 --> 00:00:02.000\nhello world\n\n"
            "00:00:01.000 --> 00:00:03.000\nhello world\n\n"
            "00:00:02.000 --> 00:00:04.000\nnext line\n"
        )
        assert _parse_vtt(vtt) == "hello world next line"

    def test_html_entities_decoded(self):
        vtt = (
            "WEBVTT\n\n"
            "00:00:00.000 --> 00:00:02.000\n"
            "Don&#39;t &amp; won&#39;t\n"
        )
        assert _parse_vtt(vtt) == "Don't & won't"

    def test_no_webvtt_header(self):
        # Some APIs omit the header; parser should still handle it.
        vtt = "00:00:00.000 --> 00:00:02.000\nbare line\n"
        assert _parse_vtt(vtt) == "bare line"


# ── _pick_track ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Track:
    id: str
    track_kind: str
    language: str


class TestPickTrack:
    def test_prefers_standard_en(self):
        tracks = [
            _Track("asr-en", "asr", "en"),
            _Track("std-de", "standard", "de"),
            _Track("std-en", "standard", "en-US"),
        ]
        assert _pick_track(tracks).id == "std-en"

    def test_falls_back_to_standard_any_lang(self):
        tracks = [
            _Track("asr-en", "asr", "en"),
            _Track("std-de", "standard", "de"),
        ]
        assert _pick_track(tracks).id == "std-de"

    def test_falls_back_to_asr_en(self):
        tracks = [
            _Track("asr-de", "asr", "de"),
            _Track("asr-en", "asr", "en"),
        ]
        assert _pick_track(tracks).id == "asr-en"

    def test_falls_back_to_any_track(self):
        tracks = [_Track("x", "", "")]
        assert _pick_track(tracks).id == "x"

    def test_empty_returns_none(self):
        assert _pick_track([]) is None


# ── fetch_transcript ─────────────────────────────────────────────────────


class FakeYouTube:
    def __init__(self, *, tracks=None, vtt=None, list_error=None, download_error=None):
        self._tracks = tracks or []
        self._vtt = vtt or ""
        self._list_error = list_error
        self._download_error = download_error
        self.list_calls = 0
        self.download_calls: list[str] = []

    def list_caption_tracks(self, video_id: str):
        self.list_calls += 1
        if self._list_error is not None:
            raise self._list_error
        return list(self._tracks)

    def download_caption(self, track_id: str) -> str:
        self.download_calls.append(track_id)
        if self._download_error is not None:
            raise self._download_error
        return self._vtt


def _vtt_wrap(text: str) -> str:
    return f"WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n{text}\n"


class _Quota:
    def __init__(self):
        self.charges: list[tuple[int, str]] = []

    def charge(self, cost: int, *, reason: str) -> None:
        self.charges.append((cost, reason))


class TestFetchTranscript:
    def test_happy_path_picks_track_and_parses(self):
        client = FakeYouTube(
            tracks=[
                _Track("asr-en", "asr", "en"),
                _Track("std-en", "standard", "en"),
            ],
            vtt=_vtt_wrap("hello there friend"),
        )
        quota = _Quota()
        result = fetch_transcript(client, "vid-1", quota=quota)
        assert isinstance(result, FetchedTranscript)
        assert result.text == "hello there friend"
        assert result.track_kind == "standard"
        assert client.download_calls == ["std-en"]
        # List (50) + download (200) both charged.
        assert [c[0] for c in quota.charges] == [50, 200]

    def test_no_tracks_returns_none_and_charges_list_only(self):
        client = FakeYouTube(tracks=[])
        quota = _Quota()
        assert fetch_transcript(client, "vid-1", quota=quota) is None
        assert client.download_calls == []
        assert [c[0] for c in quota.charges] == [50]

    def test_list_403_returns_none(self):
        client = FakeYouTube(
            list_error=PlatformAuthError("403 insufficient scope"),
        )
        quota = _Quota()
        assert fetch_transcript(client, "vid-1", quota=quota) is None
        # List cost is still charged (the call hit YouTube and was billed).
        assert [c[0] for c in quota.charges] == [50]

    def test_download_403_returns_none(self):
        client = FakeYouTube(
            tracks=[_Track("std-en", "standard", "en")],
            download_error=PlatformAuthError("403 force-ssl missing"),
        )
        quota = _Quota()
        assert fetch_transcript(client, "vid-1", quota=quota) is None
        # Download failed → only list cost charged.
        assert [c[0] for c in quota.charges] == [50]

    def test_download_api_error_returns_none(self):
        client = FakeYouTube(
            tracks=[_Track("std-en", "standard", "en")],
            download_error=PlatformAPIError("500 boom", status_code=500),
        )
        quota = _Quota()
        assert fetch_transcript(client, "vid-1", quota=quota) is None

    def test_empty_body_returns_none(self):
        client = FakeYouTube(
            tracks=[_Track("std-en", "standard", "en")],
            vtt="WEBVTT\n\n",
        )
        assert fetch_transcript(client, "vid-1") is None

    def test_truncates_at_8000_chars(self):
        long_line = "a" * 10000
        client = FakeYouTube(
            tracks=[_Track("std-en", "standard", "en")],
            vtt=_vtt_wrap(long_line),
        )
        result = fetch_transcript(client, "vid-1")
        assert result is not None
        assert len(result.text) == 8000

    def test_works_without_quota_tracker(self):
        client = FakeYouTube(
            tracks=[_Track("std-en", "standard", "en")],
            vtt=_vtt_wrap("hi"),
        )
        # No `quota` arg — should still return the transcript.
        result = fetch_transcript(client, "vid-1")
        assert result is not None
        assert result.text == "hi"
