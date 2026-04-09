/**
 * PNG-to-MP4 video converter.
 *
 * Takes a static PNG image and creates a 5-second MP4 video from it.
 * Instagram requires video (Reels) for this content format, so we convert
 * the rendered tweet image into a short looping video with silent audio.
 *
 * The silent audio track is required because Instagram may reject videos
 * without an audio stream — even if the audio is silence.
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

  const fs = require('fs');
  const tempVideo = outputPath.replace('.mp4', '.tmp.mp4');
  const silentRaw = outputPath.replace('.mp4', '.raw');

  // Create a raw silent PCM file (44100Hz * 2 channels * 2 bytes * 5 seconds)
  const silentBuffer = Buffer.alloc(44100 * 2 * 2 * 5, 0);
  fs.writeFileSync(silentRaw, silentBuffer);

  // Step 1: Create video without audio
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
      .inputOptions(['-loop 1'])
      .outputOptions(['-t 5', '-vf', 'scale=1080:1920', '-c:v libx264', '-pix_fmt yuv420p', '-r 24'])
      .output(tempVideo)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });

  // Step 2: Mux silent audio into the video
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(tempVideo)
      .input(silentRaw)
      .inputOptions(['-f s16le', '-ar 44100', '-ac 2'])
      .outputOptions(['-c:v copy', '-c:a aac', '-b:a 128k', '-shortest', '-movflags', '+faststart'])
      .output(outputPath)
      .on('end', () => {
        fs.unlinkSync(tempVideo);
        fs.unlinkSync(silentRaw);
        resolve();
      })
      .on('error', reject)
      .run();
  });
}
