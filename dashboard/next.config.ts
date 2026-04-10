import type { NextConfig } from "next";
import { resolve } from "path";

const nextConfig: NextConfig = {
  // Prevent Next.js from trying to bundle native modules used by the
  // IG pipeline. These are optionalDependencies that only exist in the
  // GitHub Actions environment where the pipeline actually runs.
  serverExternalPackages: ['apify-client', 'canvas', 'fluent-ffmpeg', 'ffmpeg-static'],
  turbopack: {
    root: resolve(import.meta.dirname),
  },
};

export default nextConfig;
