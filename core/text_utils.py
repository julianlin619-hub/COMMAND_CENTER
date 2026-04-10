"""Text normalization utilities for tweet content.

This module must produce IDENTICAL output to the TypeScript version in
dashboard/src/lib/tweet-normalize.ts. Both the cron (Python) and the
dashboard (TypeScript) normalize tweet text before storing it as a post
caption. If they normalize differently, dedup will miss matches because
the same raw tweet would produce different captions in each language.

If you change the normalization logic here, also update the TS version.
"""

from __future__ import annotations

import re


def normalize_tweet_text(raw: str) -> str:
    """Clean up raw tweet text for use as a post caption.

    Matches the TypeScript normalizeTweetText() in tweet-normalize.ts:
      1. Strip URLs (https?://...)
      2. Collapse 2+ spaces after punctuation to single space before uppercase
      3. Insert missing space after . or : before uppercase letter
      4. Collapse any remaining double spaces
      5. Trim whitespace

    Args:
        raw: Raw tweet text from Apify.

    Returns:
        Cleaned text ready for use as a post caption.
    """
    text = raw
    # Remove URLs — tweets often end with t.co links that look ugly on TikTok
    text = re.sub(r"https?://\S+", "", text)
    # Collapse 2+ spaces after . or : before uppercase → single space
    text = re.sub(r"([.:]) {2,}([A-Z])", r"\1 \2", text)
    # Insert missing space after . or : when directly followed by uppercase
    text = re.sub(r"([.:])([A-Z])", r"\1 \2", text)
    # Collapse any remaining runs of 2+ spaces into a single space
    text = re.sub(r" {2,}", " ", text)
    text = text.strip()
    return text
