"""Tests for core.youtube_studio_scheduler._clean_raw_title.

Pure function — no fixtures, no mocks. Covers the fallback title path:
when we give up waiting for captions, we clean the raw Studio title
(usually a filename) and schedule with that.
"""

from __future__ import annotations

import pytest

from core.youtube_studio_scheduler import _clean_raw_title


class TestCleanRawTitle:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            # File extensions stripped (all common video formats).
            ("hormozi_clip_v3.mp4", "hormozi clip"),
            ("clip.MOV", "clip"),
            ("something.webm", "something"),
            ("x.mkv", "x"),
            # Version markers removed (whole-word only).
            ("My Video V4 Final.mov", "My Video"),
            ("Interview Draft.mp4", "Interview"),
            ("Talk WIP.mp4", "Talk"),
            ("Session edit2.mp4", "Session"),
            ("Rough1 cut3.mp4", ""),
            # Separators → spaces.
            ("deep_work_session_draft.webm", "deep work session"),
            ("two--hyphens.mp4", "two hyphens"),
            # Case preserved.
            ("Big IDEA Final.mp4", "Big IDEA"),
            # Apostrophes preserved.
            ("Don't Skip Leg Day Final.mp4", "Don't Skip Leg Day"),
            # Nothing to clean.
            ("A perfectly clean title", "A perfectly clean title"),
            # Entirely junk → empty (caller substitutes a placeholder).
            ("edit2_rev3_rough1.mp4", ""),
            ("v2.mp4", ""),
            # Whitespace collapsed.
            ("  spaced    out   .mp4", "spaced out"),
        ],
    )
    def test_cases(self, raw, expected):
        assert _clean_raw_title(raw) == expected

    def test_truncates_long_title_on_word_boundary(self):
        raw = "word " * 30  # ~150 chars
        result = _clean_raw_title(raw.strip(), max_len=100)
        assert len(result) <= 100
        # Last char should not be a partial word.
        assert not result.endswith("wor")
        # No trailing whitespace.
        assert result == result.rstrip()

    def test_truncation_hard_cuts_when_no_space(self):
        raw = "a" * 120
        result = _clean_raw_title(raw, max_len=50)
        assert len(result) == 50

    def test_v_prefix_inside_word_preserved(self):
        # Marker regex is whole-word — "V" inside "DIVE" or "Vlogs" stays.
        assert _clean_raw_title("Vlogs from 2024.mp4") == "Vlogs from 2024"
        assert _clean_raw_title("DIVE Deep.mp4") == "DIVE Deep"

    def test_numeric_title_preserved(self):
        # "Top 10" style — digits aren't a version marker.
        assert _clean_raw_title("Top 10 Tips.mp4") == "Top 10 Tips"
