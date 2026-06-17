"""Transcribe a LOCAL media file to text — the Tweet Extractor's transcribe step.

This turns a video/audio file the user already has on disk into a full transcript
that they copy out and feed to the tweet-extraction Claude skill on desktop
(in-dashboard extraction is paused). This module is the worker for that step.

It runs entirely on local files — there is no upload and no Supabase Storage in
this path. The dashboard (running on the same machine in local dev) spawns it
with the absolute path of the file:
`python -m core.transcribe_media --file-path /Users/me/clip.mp4` (see
dashboard/src/app/api/tweet-extractor/transcribe/route.ts). The heavy lifting
(ffmpeg audio extraction + Deepgram) runs here in Python, which has the bundled
ffmpeg binary and the Deepgram key in its env.

For one file it:
  1. Extracts ONLY the audio with ffmpeg, straight into mp3 chunks in a single
     pass (the video is never decoded). The SOURCE FILE IS NOT TOUCHED.
  2. Transcribes each chunk via Deepgram and joins them in order.
  3. Removes the temp chunks and prints a one-line JSON result to stdout.

All of that lives in core.transcription.transcribe_local_file; this module is
the thin CLI wrapper around it.

Logging goes to stderr so stdout carries only the JSON result line (the
python-runner parses the last stdout line).

SECURITY: reading an arbitrary local path is safe on the user's own machine but
would be an arbitrary-file-read hole if exposed on a server, so the calling route
disables this in production (NODE_ENV=production). This module trusts the path it
is given — the route is the gate.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from core.transcription import transcribe_local_file

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# Deepgram is called over httpx, which logs every request at INFO. With a long
# recording that's one noisy line per chunk; quiet httpx/httpcore so the logs
# (and the route's stderr-tail error fallback) stay meaningful.
for _noisy in ("httpx", "httpcore"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


def transcribe_media(file_path: str) -> dict:
    """Return {"transcript": str, "sentences": [{text,start,end}, ...]} for the
    local media file at `file_path`.

    Thin wrapper over core.transcription.transcribe_local_file, which extracts
    only the audio in a single ffmpeg pass (the video is never decoded), chunks
    and transcribes it via Deepgram with whole-recording sentence timestamps, and
    cleans up its own temp files. Raises on failure (missing file, ffmpeg error,
    Deepgram error); the source file is never modified or deleted.
    """
    return transcribe_local_file(file_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe one local media file.")
    parser.add_argument(
        "--file-path",
        required=True,
        help="Absolute path to a local video/audio file on this machine.",
    )
    args = parser.parse_args()

    try:
        result = transcribe_media(args.file_path)
    except Exception as e:  # noqa: BLE001 - top-level boundary; report as JSON
        logger.error("Transcription failed: %s", e, exc_info=True)
        # stdout carries the machine-readable result; stderr has the traceback.
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    # result already has {"transcript": ..., "sentences": [...]}.
    print(json.dumps(result))


if __name__ == "__main__":
    main()
