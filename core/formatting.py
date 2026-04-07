"""Text formatting utilities: caption truncation, hashtag parsing."""

from __future__ import annotations


def truncate_caption(caption: str, max_length: int, suffix: str = "...") -> str:
    """Truncate caption to max_length, preserving whole words."""
    if len(caption) <= max_length:
        return caption
    truncated = caption[: max_length - len(suffix)]
    last_space = truncated.rfind(" ")
    if last_space > 0:
        truncated = truncated[:last_space]
    return truncated + suffix


def parse_hashtags(text: str) -> list[str]:
    """Extract hashtags from text. Returns list of tags without the # prefix."""
    return [word.lstrip("#") for word in text.split() if word.startswith("#") and len(word) > 1]


def format_hashtags(tags: list[str]) -> str:
    """Convert a list of tag strings to a space-separated hashtag string."""
    return " ".join(f"#{tag.lstrip('#')}" for tag in tags)


def strip_unsupported_chars(text: str, allowed_extra: str = "") -> str:
    """Remove characters that commonly cause issues with platform APIs."""
    # Keep printable ASCII + common unicode (emojis, accented chars)
    # Only strip actual control characters (except newline/tab)
    return "".join(
        ch for ch in text if ch in ("\n", "\t") or (ord(ch) >= 32) or ch in allowed_extra
    )
