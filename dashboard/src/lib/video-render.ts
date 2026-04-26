/**
 * PNG-to-MP4 video converter.
 *
 * Takes a static PNG image and creates a 5-second MP4 video from it.
 * Instagram requires video (Reels) for this content format, so we convert
 * the rendered tweet image into a short looping video with no audio track.
 *
 * Audio is intentionally omitted: a previous version muxed in a silent PCM
 * track encoded as AAC, which produced a faint buzz on playback. Buffer
 * accepts audio-less reels for the alexhighlights2026 queue, so we just
 * skip the audio stream entirely.
 *
 * Uses the system-installed ffmpeg binary (installed via apt in GitHub Actions).
 * fluent-ffmpeg is an optionalDependency — this module only runs in the
 * pipeline API routes inside GitHub Actions, not during normal dashboard use.
 */

export async function renderPngToVideo(inputPath: string, outputPath: string): Promise<void> {
  // Lazy-load fluent-ffmpeg to avoid crashing environments where it's not installed
  const ffmpegModule = await import('fluent-ffmpeg');
  const ffmpeg = ffmpegModule.default;

  // Use system ffmpeg (installed via apt-get in GitHub Actions).
  // If FFMPEG_PATH is set, use that; otherwise rely on PATH lookup.
  if (process.env.FFMPEG_PATH) {
    ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
  }

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
      .inputOptions(['-loop 1'])
      .outputOptions([
        '-t 5',
        '-vf', 'scale=1080:1920',
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-r 24',
        '-an',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}
