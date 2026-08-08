"""Ad Carousels Pipeline — manually-triggered, never a scheduled cron.

Two modes, selected by the stdin JSON payload:

1. Build the bank (a once-off, rerunnable pass):
       {"mode": "build_bank", "prompt": "..."}
   Runs EVERY master-bank tweet (tweet_bank table, ~5K rows) through a
   batched Claude filter against the brief and stores the keepers in the
   ads_bank table. No likes floor by design — a bigger bank means more
   possible permutations. Rebuilding wipes and refills ads_bank.

2. Generate a batch of carousel permutations:
       {"mode": "generate", "count": 100, "cta_text": "...", "dry_run": false}
   Each carousel = 7 tweets picked at random from ads_bank, in random
   order, plus the CTA as the LAST slide (8 cards total). The
   permutation rule: every carousel must differ from EVERY carousel
   ever generated (this run or any before it, via the ads_carousels
   ledger) by at least 3 tweets — i.e. no two carousels share more than
   4 of their 7. Order within a carousel is ignored by the rule, so
   reshuffles never sneak past it.

   Output: one Google Drive batch folder per run, containing a numbered
   subfolder per carousel (01.png … 08.png, CTA last). Each unique slide
   PNG is uploaded once to an _assets subfolder and server-side COPIED
   into carousel folders — copies are cheap metadata calls, re-uploads
   are not. Ledger rows are inserted per-carousel as folders complete,
   so a mid-run crash still remembers everything already produced.

No Buffer, no posts rows — Drive IS the output.

Run via: python3 -m core.ads_carousel_pipeline
(invoked from dashboard/src/app/api/ads-carousels/run/route.ts)

Logging goes to stderr; the final JSON summary goes to stdout.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sys
import time
from datetime import datetime

import anthropic

from core.content_gen_client import generate_content
from core.database import (
    get_client,
    log_cron_finish,
    log_cron_start,
    sanitize_error_message,
)
from core.env_diag import log_env_diagnostics
from core.google_drive import (
    copy_file,
    create_folder,
    get_access_token,
    upload_png,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)

# 7 tweets + 1 CTA = 8 cards total (operator's chosen carousel size).
_TWEETS_PER_CAROUSEL = 7

# The dedup rule: at least 3 tweets must differ from every previous
# carousel, so a new one may share at most (size - 3) tweets. Derived
# from the size so changing _TWEETS_PER_CAROUSEL keeps the ">= 3
# differ" semantics intact. Compared as SETS, so the same tweets
# reshuffled still count as a repeat.
_MAX_SHARED_TWEETS = _TWEETS_PER_CAROUSEL - 3

# Batch ceiling per run — matches the UI. Bigger batches risk the
# dashboard route's timeout; the ledger makes consecutive runs additive
# anyway, so there's no reason to push one run harder.
_MAX_BATCH = 100

# Rejection-sampling budget per carousel before declaring the
# permutation space saturated for this bank.
_MAX_ATTEMPTS_PER_CAROUSEL = 20_000

# Claude filter batch size for the bank build. ~150 tweets ≈ 5K input
# tokens per call; the whole 5K-row master bank filters in ~35 calls.
_FILTER_CHUNK_SIZE = 150

# Supabase caps selects at 1000 rows per request — page with .range().
_PAGE_SIZE = 1000


def _fail(message: str) -> None:
    """Print a JSON error line (the route parses the last stdout line) and exit."""
    print(json.dumps({"status": "error", "error": message}))
    sys.exit(1)


def _fetch_all(table: str, columns: str) -> list[dict]:
    """Read every row of a table, paging past Supabase's 1000-row cap."""
    client = get_client()
    rows: list[dict] = []
    offset = 0
    while True:
        result = (
            client.table(table)
            .select(columns)
            .range(offset, offset + _PAGE_SIZE - 1)
            .execute()
        )
        batch = result.data or []
        rows.extend(batch)
        if len(batch) < _PAGE_SIZE:
            return rows
        offset += _PAGE_SIZE


# ─────────────────────────────────────────────────────────────────────────────
# Claude topical filter (shared by the bank build)
# ─────────────────────────────────────────────────────────────────────────────

# The filter judges topical fit only — completeness/quality gating is the
# bank's job (it's already curated). Batched: per-tweet calls over a 5K
# bank would take hours for no accuracy gain.
_FILTER_SYSTEM_PROMPT = """You select tweets that fit a content brief.

You are given a brief describing what kind of tweets the user wants, and a numbered list of candidate tweets. Keep only the tweets that genuinely fit the brief, and drop the ones that don't.

Judge topical fit ONLY. Do not judge writing quality, length, or engagement — the candidates are already curated.

Return JSON: {"keep_indices": [list of the [N] indices of tweets that fit the brief]}. Keep every tweet that fits; do not cap the list. Return an empty list if nothing fits. No prose, no other fields."""

_FILTER_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "keep_indices": {
            "type": "array",
            "items": {"type": "integer"},
        },
    },
    "required": ["keep_indices"],
    "additionalProperties": False,
}


def _filter_on_topic(
    prompt: str,
    candidates: list[dict],
    *,
    client: anthropic.Anthropic | None = None,
) -> list[dict]:
    """Return the subset of `candidates` Claude judges as fitting the brief.

    One call over the given candidate chunk. SDK/parse errors propagate —
    a flaky key should fail the run loudly, not silently build a
    half-filtered bank (same policy as core/tweet_filter.py).
    Pass `client` to inject a mock in tests.
    """
    if client is None:
        client = anthropic.Anthropic()

    numbered = "\n".join(
        f"[{i}] {c['text']}" for i, c in enumerate(candidates)
    )
    user_message = f"Brief: {prompt}\n\nCandidate tweets:\n{numbered}"

    response = client.messages.create(
        model="claude-sonnet-4-6",
        # Enough headroom for ~150 indices in the keep list.
        max_tokens=4096,
        thinking={"type": "disabled"},
        system=_FILTER_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
        output_config={
            "format": {"type": "json_schema", "schema": _FILTER_OUTPUT_SCHEMA}
        },
    )

    raw = next(b.text for b in response.content if b.type == "text")
    keep_indices = json.loads(raw)["keep_indices"]

    # Out-of-range indices are a model slip, not a reason to crash the
    # build — log and drop them; the in-range picks are still good.
    valid = [i for i in keep_indices if isinstance(i, int) and 0 <= i < len(candidates)]
    if len(valid) != len(keep_indices):
        logger.warning(
            "Filter returned %d out-of-range index(es) — ignored",
            len(keep_indices) - len(valid),
        )
    return [candidates[i] for i in sorted(set(valid))]


# ─────────────────────────────────────────────────────────────────────────────
# Mode 1: build the ads bank
# ─────────────────────────────────────────────────────────────────────────────


def _replace_ads_bank(kept: list[dict]) -> None:
    """Wipe ads_bank and refill it with the filter's keepers.

    Wipe-and-refill (not merge) because a rebuild means the brief
    changed — stale keepers from the old brief shouldn't linger.
    """
    client = get_client()
    # Supabase requires a filter on delete; tweet_id is never empty, so
    # this matches every row.
    client.table("ads_bank").delete().neq("tweet_id", "").execute()
    rows = [
        {
            "tweet_id": t["tweet_id"],
            "text": t["text"],
            "favorite_count": t.get("favorite_count"),
        }
        for t in kept
    ]
    # Chunked inserts keep each request comfortably under body limits.
    for i in range(0, len(rows), 500):
        client.table("ads_bank").insert(rows[i : i + 500]).execute()


def _run_build_bank(prompt: str) -> None:
    run_id = log_cron_start(platform="ads", job_type="ads_bank_build")
    try:
        master = _fetch_all("tweet_bank", "tweet_id, text, favorite_count")
        if not master:
            raise RuntimeError(
                "tweet_bank is empty — run scripts/embed_tweet_bank.py "
                "(or check SUPABASE_* env vars)."
            )
        logger.info("Filtering %d master-bank tweet(s) against the brief", len(master))

        client = anthropic.Anthropic()
        kept: list[dict] = []
        for i in range(0, len(master), _FILTER_CHUNK_SIZE):
            chunk = master[i : i + _FILTER_CHUNK_SIZE]
            kept.extend(_filter_on_topic(prompt, chunk, client=client))
            logger.info(
                "Filtered %d/%d — %d kept so far",
                min(i + _FILTER_CHUNK_SIZE, len(master)), len(master), len(kept),
            )

        if not kept:
            raise RuntimeError(
                "The filter kept 0 tweets — the brief is probably too narrow."
            )

        _replace_ads_bank(kept)
        log_cron_finish(run_id, status="success", posts_processed=len(kept))
        print(json.dumps({
            "status": "success",
            "mode": "build_bank",
            "scanned": len(master),
            "bank_size": len(kept),
        }))
    except Exception as e:
        error = sanitize_error_message(str(e))
        logger.error("Bank build failed: %s", error, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=error)
        _fail(error)


# ─────────────────────────────────────────────────────────────────────────────
# Mode 2: generate permutations
# ─────────────────────────────────────────────────────────────────────────────


def _sample_permutations(
    bank_ids: list[str],
    existing_sets: list[set[str]],
    count: int,
    *,
    rng: random.Random,
) -> list[list[str]]:
    """Draw up to `count` random tweet permutations honoring the dedup rule.

    Rejection sampling: draw a random sample (which is also the random
    slide order), keep it only if it shares <= _MAX_SHARED_TWEETS tweets
    with every set ever accepted (ledger + this run). Returns fewer than
    `count` when the space saturates — the caller reports the shortfall
    instead of looping forever.
    """
    accepted: list[list[str]] = []
    all_sets = list(existing_sets)
    for _ in range(count):
        for _attempt in range(_MAX_ATTEMPTS_PER_CAROUSEL):
            combo = rng.sample(bank_ids, _TWEETS_PER_CAROUSEL)
            combo_set = set(combo)
            if all(
                len(combo_set & prev) <= _MAX_SHARED_TWEETS for prev in all_sets
            ):
                accepted.append(combo)
                all_sets.append(combo_set)
                break
        else:
            logger.warning(
                "Permutation space saturated after %d carousel(s) — bank has "
                "%d tweet(s); grow the bank to unlock more.",
                len(accepted), len(bank_ids),
            )
            break
    return accepted


def _render_unique_slides(
    texts_by_id: dict[str, str],
    *,
    dashboard_url: str,
    cron_secret: str,
) -> dict[str, str]:
    """Render each unique slide once; returns {slide_id: storage_path}.

    Chunked so no single render request risks the content-gen client's
    300s timeout. ALL slides must render or this raises — a carousel
    with a missing slide is worse than no carousel, and nothing has been
    uploaded to Drive yet so failing here is clean.
    """
    payload = [{"id": sid, "text": text} for sid, text in texts_by_id.items()]
    rendered: dict[str, dict] = {}
    chunk_size = 50
    for i in range(0, len(payload), chunk_size):
        chunk = payload[i : i + chunk_size]
        data = generate_content(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=chunk,
            platform="ads",
        )
        if data.get("error"):
            raise RuntimeError(data["error"])
        for j, err in enumerate(data.get("errors", []) or []):
            logger.warning("  ads render error[%d]: %s", j, err)
        # Re-map by id — the route drops failed items, so response order
        # can't be trusted.
        for item in data.get("generated", []) or []:
            rendered[str(item["id"])] = item
        logger.info("Rendered %d/%d unique slide(s)", len(rendered), len(payload))

    missing = [p["id"] for p in payload if p["id"] not in rendered]
    if missing:
        raise RuntimeError(f"Render dropped {len(missing)} slide(s): {missing[:5]}…")
    return {sid: rendered[sid]["storagePath"] for sid in texts_by_id}


def _download_slide(storage_path: str) -> bytes:
    """Fetch rendered PNG bytes straight from Supabase Storage.

    The service key reads the private `media` bucket directly — no
    signed-URL dance needed inside Python.
    """
    return get_client().storage.from_("media").download(storage_path)


def _run_generate(count: int, cta_text: str, *, dry_run: bool) -> None:
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")

    run_id = log_cron_start(platform="ads", job_type="ads_carousel")
    try:
        # 1. Load the bank + the full ledger of everything ever generated.
        bank = _fetch_all("ads_bank", "tweet_id, text")
        if len(bank) < _TWEETS_PER_CAROUSEL:
            raise RuntimeError(
                f"ads_bank has only {len(bank)} tweet(s) — need at least "
                f"{_TWEETS_PER_CAROUSEL}. Build the bank first."
            )
        texts = {t["tweet_id"]: t["text"] for t in bank}
        ledger = _fetch_all("ads_carousels", "tweet_ids")
        existing_sets = [set(row["tweet_ids"]) for row in ledger]
        logger.info(
            "Bank: %d tweet(s) · ledger: %d existing carousel(s)",
            len(bank), len(existing_sets),
        )

        # 2. Sample the batch. Un-seeded Random(): permutations should
        # genuinely differ run to run.
        combos = _sample_permutations(
            list(texts), existing_sets, count, rng=random.Random()
        )
        if not combos:
            raise RuntimeError(
                f"Could not generate ANY new permutation — the bank "
                f"({len(bank)} tweets) is exhausted under the >=3-differ "
                f"rule with {len(existing_sets)} carousels already made. "
                f"Broaden the brief and rebuild the bank."
            )

        # 3. Render each unique slide once (tweets used in this batch + CTA).
        cta_id = f"cta-{int(time.time())}"
        unique_ids = {tid for combo in combos for tid in combo}
        to_render = {tid: texts[tid] for tid in unique_ids}
        to_render[cta_id] = cta_text
        storage_paths = _render_unique_slides(
            to_render, dashboard_url=dashboard_url, cron_secret=cron_secret
        )

        if dry_run:
            logger.info(
                "DRY RUN — %d permutation(s) sampled, %d unique slide(s) "
                "rendered, skipping Drive + ledger.",
                len(combos), len(storage_paths),
            )
            log_cron_finish(run_id, status="success", posts_processed=0)
            print(json.dumps({
                "status": "success",
                "mode": "generate",
                "dry_run": True,
                "requested": count,
                "generated": len(combos),
                "unique_slides": len(storage_paths),
                "folder_url": None,
            }))
            return

        # 4. Drive: batch folder → _assets (each unique PNG uploaded once)
        # → numbered carousel folders filled via server-side copies.
        token = get_access_token()
        batch_folder = create_folder(
            f"Ad Carousels {datetime.now():%Y-%m-%d %H%M} ({len(combos)})",
            os.environ["ADS_DRIVE_FOLDER_ID"],
            token,
        )
        assets_folder = create_folder("_assets", batch_folder["id"], token)
        asset_ids: dict[str, str] = {}
        for sid, storage_path in storage_paths.items():
            # Download → upload → drop the bytes; holding a whole batch of
            # PNGs in memory would strain the dashboard instance.
            asset_ids[sid] = upload_png(
                f"{sid}.png", _download_slide(storage_path), assets_folder["id"], token
            )
        logger.info("Uploaded %d unique slide(s) to _assets", len(asset_ids))

        # Number carousels globally (ledger count continues across runs) so
        # folder names never collide between batches.
        client = get_client()
        next_number = len(existing_sets) + 1
        for i, combo in enumerate(combos):
            folder = create_folder(
                f"carousel-{next_number + i:04d}", batch_folder["id"], token
            )
            for pos, tid in enumerate(combo):
                copy_file(asset_ids[tid], f"{pos + 1:02d}.png", folder["id"], token)
            copy_file(
                asset_ids[cta_id],
                f"{_TWEETS_PER_CAROUSEL + 1:02d}.png",
                folder["id"],
                token,
            )
            # Ledger row per carousel, immediately after its folder
            # completes — a mid-run crash still remembers these, so the
            # next run can't regenerate overlapping permutations.
            client.table("ads_carousels").insert({
                "tweet_ids": combo,
                "drive_folder_id": folder["id"],
                "drive_folder_url": folder["webViewLink"],
            }).execute()
            if (i + 1) % 10 == 0 or i + 1 == len(combos):
                logger.info("Built %d/%d carousel folder(s)", i + 1, len(combos))

        log_cron_finish(run_id, status="success", posts_processed=len(combos))
        print(json.dumps({
            "status": "success",
            "mode": "generate",
            "requested": count,
            "generated": len(combos),
            "total_permutations": len(existing_sets) + len(combos),
            "folder_url": batch_folder["webViewLink"],
        }))
    except Exception as e:
        error = sanitize_error_message(str(e))
        logger.error("Ads carousel run failed: %s", error, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=error)
        _fail(error)


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────


def main() -> None:
    # argparse with no positional args — all input arrives via stdin.
    argparse.ArgumentParser(
        description="Build the ads tweet bank or generate carousel permutation batches."
    ).parse_args()

    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        _fail("stdin was not valid JSON")

    mode = str(payload.get("mode", "")).strip()

    if mode == "build_bank":
        # log_env_diagnostics installs the log sanitizer as a side effect,
        # so everything logged after this line has secrets redacted.
        log_env_diagnostics(
            "ads-carousel-pipeline",
            required=["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "ANTHROPIC_API_KEY"],
        )
        prompt = str(payload.get("prompt", "")).strip()
        if not prompt:
            _fail("prompt is required for build_bank")
        _run_build_bank(prompt)
    elif mode == "generate":
        log_env_diagnostics(
            "ads-carousel-pipeline",
            required=[
                "SUPABASE_URL",
                "SUPABASE_SERVICE_KEY",
                "DASHBOARD_URL",
                "CRON_SECRET",
                "GDRIVE_CLIENT_ID",
                "GDRIVE_CLIENT_SECRET",
                "GDRIVE_REFRESH_TOKEN",
                "ADS_DRIVE_FOLDER_ID",
            ],
        )
        cta_text = str(payload.get("cta_text", "")).strip()
        count = payload.get("count")
        dry_run = bool(payload.get("dry_run", False))
        if not cta_text:
            _fail("cta_text is required for generate")
        if not isinstance(count, int) or not (1 <= count <= _MAX_BATCH):
            _fail(f"count must be an integer between 1 and {_MAX_BATCH}")
        _run_generate(count, cta_text, dry_run=dry_run)
    else:
        _fail('mode must be "build_bank" or "generate"')


if __name__ == "__main__":
    main()
