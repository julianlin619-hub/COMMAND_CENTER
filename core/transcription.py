"""Audio extraction (ffmpeg) + transcription (Deepgram) for batch video upload.

The batch manual-upload pathway needs a transcript of each uploaded mp4 to
feed the title generator and the caption RAG lookup. Two steps:

  1. extract_audio() — download the uploaded video to a local temp file, then
     pull a small mono 16 kHz mp3 out of it with ffmpeg. Only the audio track
     is decoded; the resulting mp3 is a few MB at most, and the downloaded
     video is deleted as soon as extraction finishes.

  2. transcribe() — POST those mp3 bytes to Deepgram's prerecorded API.

Why download first instead of streaming the signed URL into ffmpeg? The earlier
version passed the Supabase HTTPS signed URL straight to `ffmpeg -i` to avoid
writing the full video to disk. But the bundled `imageio-ffmpeg` static binary
is a minimal build and could not reliably open the remote HTTPS input on Render
— it printed its banner and exited non-zero with no usable diagnostic. Letting
Python's TLS stack fetch the bytes (via core.media.download_file, which already
follows redirects and guards size) and handing ffmpeg a plain local file is far
more robust and matches how every other cron pathway here consumes media.

ffmpeg comes from the `imageio-ffmpeg` package's bundled static binary rather
than a system install: Render's Python build can't apt-get ffmpeg (sudo is
disallowed), and bundling keeps local dev and production identical.
"""

from __future__ import annotations

import glob
import logging
import os
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx

from core.media import download_file, get_signed_url
from core.retry import raise_for_retryable_status, with_retry

logger = logging.getLogger(__name__)

DEEPGRAM_URL = "https://api.deepgram.com/v1/listen"

# Deepgram model. nova-3 is their latest general transcription model;
# smart_format adds punctuation/capitalisation so the transcript reads cleanly
# for the title prompt. Bump the model string here if Deepgram ships a newer one.
DEEPGRAM_MODEL = "nova-3"

# Cap each ffmpeg invocation so one bad file can't hang forever. Short clips
# finish in seconds. A 4-hour file's audio-only extract+segment pass (-vn, so
# the video is never decoded) is the slow case — still far faster than realtime,
# but we allow 20 minutes of headroom. Both extract_audio (Storage path) and
# extract_audio_chunks_local (local path) use this cap.
_FFMPEG_TIMEOUT_SECONDS = 1200

# Cap the video download. Mirror the manual uploader's 2 GB ceiling
# (dashboard sign-url/route.ts) so we accept anything the UI let through but
# never let a runaway download fill Render's /tmp.
_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024

# Deepgram returns quickly for short audio; generous window for a hung socket.
_DEEPGRAM_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

# How long an audio segment may be before we split it for transcription. A
# single Deepgram request for a multi-hour file would risk the response timeout
# above, so transcribe_local_file() extracts the audio into <= this many seconds
# per chunk. 10 minutes is comfortably inside Deepgram's prerecorded limits and
# keeps each call fast. Override via env for tuning.
_CHUNK_SECONDS = int(os.environ.get("TRANSCRIBE_CHUNK_SECONDS", "600"))

# How many chunk transcriptions to run at once. Deepgram calls are I/O-bound
# (we're just waiting on HTTP), so modest concurrency turns a 4-hour serial
# transcription into a handful of parallel batches without hammering the API.
# Output order is reconstructed regardless of completion order.
_CHUNK_CONCURRENCY = max(1, int(os.environ.get("TRANSCRIBE_CHUNK_CONCURRENCY", "4")))


def _ffmpeg_exe() -> str:
    """Path to the bundled ffmpeg binary.

    Imported lazily so importing this module (e.g. in tests that mock
    transcribe) doesn't require imageio-ffmpeg to be installed.
    """
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def _ffmpeg_to_mp3(input_path: str, dest_dir: str = "/tmp") -> str:
    """Decode a LOCAL media file's audio track to a mono 16 kHz mp3 with ffmpeg.

    Returns the temp mp3 path; removes any partial mp3 and re-raises if ffmpeg
    fails. Mono + 16 kHz keeps the mp3 tiny and is plenty for speech
    transcription (Deepgram resamples internally anyway). The input is a plain
    local path, so we pin -protocol_whitelist to file.
    """
    out_path = os.path.join(dest_dir, f"{uuid.uuid4()}.mp3")
    # -nostdin: never block on stdin. -vn: drop video. -ac 1 / -ar 16000: mono,
    # 16 kHz. -y: overwrite the (uuid-named) target if it somehow exists.
    cmd = [
        _ffmpeg_exe(),
        "-nostdin",
        "-protocol_whitelist", "file",
        "-i", input_path,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-f", "mp3",
        "-y",
        out_path,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=_FFMPEG_TIMEOUT_SECONDS
        )
        if result.returncode != 0:
            # ffmpeg writes diagnostics to stderr; keep a generous tail with the
            # exit code. A NEGATIVE returncode means a signal kill (e.g. OOM).
            tail = (result.stderr or "").strip().splitlines()[-20:]
            raise RuntimeError(
                f"ffmpeg audio extraction failed (exit {result.returncode}): "
                + " | ".join(tail)
            )
    except Exception:
        # Clean up a partially-written mp3 on ANY failure (non-zero exit,
        # timeout, OSError). Best-effort: a missing file is fine.
        _safe_remove(out_path)
        raise
    return out_path


def extract_audio(storage_path: str, dest_dir: str = "/tmp") -> str:
    """Extract a mono 16 kHz mp3 from a video in Supabase Storage.

    Downloads the video to a local temp file (core.media.download_file: Python's
    TLS stack, follows redirects, guards size) and decodes its audio to mp3.
    Returns the mp3 path; the downloaded video is always deleted before return.
    Used by the batch-video pathway (core.video_batch). For a file already on
    local disk, use extract_audio_chunks_local() instead — no download.
    """
    signed_url = get_signed_url(storage_path)
    logger.info("Extracting audio from %s", storage_path)
    # Fetch the bytes ourselves rather than letting ffmpeg open the remote URL:
    # the bundled static ffmpeg can't reliably read an HTTPS input (see module
    # docstring). download_file streams to /tmp with size + traversal guards.
    local_video = download_file(signed_url, dest_dir=dest_dir, max_bytes=_MAX_VIDEO_BYTES)
    try:
        out_path = _ffmpeg_to_mp3(local_video, dest_dir)
    finally:
        # Always drop the downloaded video — a leftover (up to 2 GB) would fill
        # /tmp across repeated jobs.
        _safe_remove(local_video)
    logger.info("Extracted audio → %s", out_path)
    return out_path


def _safe_remove(path: str) -> None:
    """Delete a file if it exists, best-effort (a missing file is fine)."""
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError as cleanup_err:
        logger.warning("Could not remove %s: %s", path, cleanup_err)


@with_retry()
def _deepgram_request(api_key: str, audio: bytes) -> dict:
    """POST audio to Deepgram, returning the parsed JSON body.

    Wrapped in @with_retry so a transient hiccup (a 429, a 5xx, or a dropped
    connection) is retried with backoff instead of failing the whole batch job
    on the first miss. We translate the HTTP status into our exception
    hierarchy (raise_for_retryable_status) so the retry helper knows a 429/5xx
    is worth retrying but a 4xx (e.g. a bad key) is not — and we honor
    Deepgram's Retry-After header when it sends one.
    """
    resp = httpx.post(
        DEEPGRAM_URL,
        # paragraphs=true makes Deepgram return sentence-level timestamps
        # (alternatives[].paragraphs.paragraphs[].sentences[] with start/end),
        # which the tweet extractor uses to locate each draft in the recording.
        # It's harmless for the plain-text callers (they read only `transcript`).
        params={"model": DEEPGRAM_MODEL, "smart_format": "true", "paragraphs": "true"},
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": "audio/mpeg",
        },
        content=audio,
        timeout=_DEEPGRAM_TIMEOUT,
    )
    if not resp.is_success:
        retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
        # resp.text can echo the request context; the log sanitizer + DB
        # sanitizer scrub anything secret before it's persisted/emitted.
        raise_for_retryable_status(
            resp.status_code, retry_after=retry_after, body=resp.text
        )
    return resp.json()


def _parse_retry_after(raw: str | None) -> float | None:
    """Coerce a Retry-After header (seconds) to a float, or None if absent/bad."""
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        # Retry-After can also be an HTTP date; we don't parse that — fall back
        # to the retry helper's exponential backoff by returning None.
        return None


def _read_api_key() -> str:
    api_key = os.environ.get("DEEPGRAM_API_KEY", "")
    if not api_key:
        raise RuntimeError("DEEPGRAM_API_KEY env var not set")
    return api_key


def _transcribe_one(mp3_path: str, api_key: str) -> str:
    """Transcribe a single local mp3 via Deepgram. Returns text, possibly empty.

    An empty result is NOT treated as an error here: a silent segment is normal
    in a long recording (a pause, music, dead air), and the chunked caller skips
    empties rather than failing the whole job. The strict `transcribe()` below
    wraps this and raises on empty for the single-file callers that need speech.
    """
    with open(mp3_path, "rb") as f:
        audio = f.read()

    body = _deepgram_request(api_key, audio)

    # Deepgram's prerecorded response nests the transcript under
    # results.channels[0].alternatives[0].transcript. Navigate defensively so
    # a schema surprise raises a clear error instead of a bare KeyError.
    try:
        return (
            body["results"]["channels"][0]["alternatives"][0]["transcript"]
        ).strip()
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Unexpected Deepgram response shape: {e}") from e


def transcribe(mp3_path: str) -> str:
    """Transcribe a local mp3 via Deepgram's prerecorded API. Returns text.

    Raises if DEEPGRAM_API_KEY is unset, the request fails, or Deepgram
    returns an empty transcript (a clip with no speech is not something we
    can title or caption, so the caller should mark the job failed). This is the
    single-request path used by the batch-video pathway (core.video_batch); for
    a possibly-hours-long local file use transcribe_local_file().
    """
    transcript = _transcribe_one(mp3_path, _read_api_key())
    if not transcript:
        raise RuntimeError("Deepgram returned an empty transcript (no speech?)")
    logger.info("Transcribed %s (%d chars)", mp3_path, len(transcript))
    return transcript


def extract_audio_chunks_local(
    local_path: str, chunk_seconds: int = _CHUNK_SECONDS, dest_dir: str = "/tmp"
) -> list[str]:
    """Extract a LOCAL video/audio file's audio into mono 16 kHz mp3 chunks of
    <= chunk_seconds, in a SINGLE ffmpeg pass. Returns chunk paths in order.

    This is the efficient "just get the audio" step for a long video: `-vn` means
    the video is never decoded, and the segment muxer writes the chunks directly,
    so there's no full-length intermediate mp3 and no second pass. A short file
    yields a single chunk. The SOURCE FILE IS NEVER MODIFIED OR DELETED — it's the
    user's own file; only temp chunk files are created (the caller removes them).
    Raises (and cleans up any partial chunks) if ffmpeg fails or writes nothing.
    """
    if not os.path.isfile(local_path):
        raise FileNotFoundError(f"No such file: {local_path}")

    prefix = os.path.join(dest_dir, f"{uuid.uuid4()}_chunk_")
    pattern = f"{prefix}%04d.mp3"
    # -vn drops the video stream (only the audio track is decoded → fast even for
    # a 4-hour file). -ac 1/-ar 16000 downsample to mono 16 kHz. The segment muxer
    # (-f segment) splits the re-encoded audio into <=chunk_seconds mp3 files.
    cmd = [
        _ffmpeg_exe(),
        "-nostdin",
        "-protocol_whitelist", "file",
        "-i", local_path,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-f", "segment",
        "-segment_time", str(chunk_seconds),
        "-y",
        pattern,
    ]
    logger.info("Extracting audio (chunked, single pass) from %s", local_path)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=_FFMPEG_TIMEOUT_SECONDS
        )
        if result.returncode != 0:
            tail = (result.stderr or "").strip().splitlines()[-20:]
            raise RuntimeError(
                f"ffmpeg audio extraction failed (exit {result.returncode}): "
                + " | ".join(tail)
            )
    except Exception:
        # Clean up any partial chunks on failure (non-zero exit, timeout, OSError).
        for partial in glob.glob(f"{prefix}*.mp3"):
            _safe_remove(partial)
        raise

    chunks = sorted(glob.glob(f"{prefix}*.mp3"))
    if not chunks:
        raise RuntimeError("ffmpeg produced no audio segments")
    logger.info("Extracted %d audio chunk(s) of <=%ds", len(chunks), chunk_seconds)
    return chunks


def _transcribe_one_detailed(mp3_path: str, api_key: str) -> dict:
    """Transcribe one local mp3 via Deepgram, returning sentence-level timestamps
    and the chunk's audio duration — all RELATIVE to this chunk:

        {"sentences": [{"text": str, "start": float, "end": float}, ...],
         "duration": float}

    Sentences come from Deepgram's paragraphs (paragraphs=true). A silent chunk
    yields an empty sentence list (not an error); the caller fails only if every
    chunk is empty. Parsed defensively. `duration` is what the chunked caller sums
    to offset later chunks onto a whole-recording timeline.
    """
    with open(mp3_path, "rb") as f:
        audio = f.read()
    body = _deepgram_request(api_key, audio)

    duration = 0.0
    try:
        duration = float(body["metadata"]["duration"])
    except (KeyError, TypeError, ValueError):
        pass  # offset just won't advance for this chunk — better than failing

    try:
        alt = body["results"]["channels"][0]["alternatives"][0]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Unexpected Deepgram response shape: {e}") from e

    sentences: list[dict] = []
    for para in (alt.get("paragraphs") or {}).get("paragraphs", []) or []:
        for s in para.get("sentences", []) or []:
            text = (s.get("text") or "").strip()
            if not text:
                continue
            sentences.append({
                "text": text,
                "start": float(s.get("start") or 0.0),
                "end": float(s.get("end") or 0.0),
            })
    return {"sentences": sentences, "duration": duration}


def transcribe_local_file(local_path: str) -> dict:
    """Transcribe a possibly-hours-long LOCAL video/audio file, returning the full
    transcript AND sentence-level timestamps for the WHOLE recording:

        {"transcript": str, "sentences": [{"text", "start", "end"}, ...]}

    Pipeline: ffmpeg extracts the audio into mp3 chunks in one pass
    (extract_audio_chunks_local — video is never decoded), then each chunk is
    transcribed via Deepgram with bounded concurrency (they're I/O-bound, so a
    4-hour file is a few parallel batches, not an hour of serial waiting). Each
    chunk's sentence times are RELATIVE to that chunk, so we offset them by the
    cumulative duration of the prior chunks (Deepgram's metadata.duration per
    chunk is exact) to place every sentence on a single whole-recording timeline.
    The transcript is the sentences joined, so it and the timestamps stay aligned.
    Only an all-empty result is a failure. Temp chunks are always removed; the
    source file is left untouched.
    """
    chunks = extract_audio_chunks_local(local_path)
    try:
        api_key = _read_api_key()
        logger.info(
            "Transcribing %d chunks (concurrency %d)", len(chunks), _CHUNK_CONCURRENCY
        )
        # Key results by chunk index so offsets apply in order, not completion order.
        per_chunk: list[dict | None] = [None] * len(chunks)
        with ThreadPoolExecutor(max_workers=_CHUNK_CONCURRENCY) as pool:
            futures = {
                pool.submit(_transcribe_one_detailed, chunk, api_key): i
                for i, chunk in enumerate(chunks)
            }
            for fut in as_completed(futures):
                per_chunk[futures[fut]] = fut.result()

        sentences: list[dict] = []
        offset = 0.0
        for result in per_chunk:
            if result is None:
                continue
            for s in result["sentences"]:
                sentences.append({
                    "text": s["text"],
                    "start": round(s["start"] + offset, 2),
                    "end": round(s["end"] + offset, 2),
                })
            offset += result["duration"]

        transcript = " ".join(s["text"] for s in sentences).strip()
        if not transcript:
            raise RuntimeError(
                "Deepgram returned an empty transcript for every chunk (no speech?)"
            )
        logger.info(
            "Transcribed %d chunks → %d sentences, %d chars",
            len(chunks), len(sentences), len(transcript),
        )
        return {"transcript": transcript, "sentences": sentences}
    finally:
        for chunk in chunks:
            _safe_remove(chunk)
