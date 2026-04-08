"""Text formatting utilities: caption truncation, hashtag parsing.

Each social media platform has different rules for text length, allowed
characters, and hashtag formatting. These utilities normalize text before
sending it to platform APIs so we don't get rejected for exceeding limits
or including invisible control characters.
"""

from __future__ import annotations


def truncate_caption(caption: str, max_length: int, suffix: str = "...") -> str:
    """Truncate caption to max_length, preserving whole words."""
    if len(caption) <= max_length:
        return caption
    # Reserve space for the suffix (e.g. "...") so the total stays within the limit
    truncated = caption[: max_length - len(suffix)]
    # Find the last space so we cut at a word boundary instead of mid-word.
    # "Hello wonderful world" -> "Hello wonderful" (not "Hello wonderfu...")
    last_space = truncated.rfind(" ")
    if last_space > 0:
        truncated = truncated[:last_space]
    return truncated + suffix


def parse_hashtags(text: str) -> list[str]:
    """Extract hashtags from text. Returns list of tags without the # prefix."""
    # Split on whitespace, keep words that start with # and have at least
    # one character after the #. Lone "#" symbols are ignored (len(word) > 1).
    return [word.lstrip("#") for word in text.split() if word.startswith("#") and len(word) > 1]


def format_hashtags(tags: list[str]) -> str:
    """Convert a list of tag strings to a space-separated hashtag string."""
    # lstrip('#') handles the case where tags already include the # prefix,
    # so passing ["#python", "coding"] both produce "#python #coding".
    return " ".join(f"#{tag.lstrip('#')}" for tag in tags)


def strip_unsupported_chars(text: str, allowed_extra: str = "") -> str:
    """Remove characters that commonly cause issues with platform APIs.

    Some platform APIs reject posts containing invisible control characters
    (like null bytes, backspaces, or form feeds) that can sneak in from
    copy-pasted text. We strip those but deliberately keep:
      - Newlines and tabs (they're valid formatting in captions)
      - Emojis and accented characters (ord >= 32 covers all of these)
      - Any extra characters the caller explicitly allows via allowed_extra
    """
    return "".join(
        ch for ch in text if ch in ("\n", "\t") or (ord(ch) >= 32) or ch in allowed_extra
    )
