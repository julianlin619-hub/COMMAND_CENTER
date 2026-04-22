/**
 * Single source of truth for the hardcoded content defaults the YouTube
 * second-channel upload flow sends to the YouTube Data API v3.
 *
 * The dashboard form only asks for a file + title. Everything else is
 * constant across every upload to this channel, so we pin it here to
 * avoid scattering magic values across API routes.
 *
 * If you need to tweak the description without a redeploy, set
 * YOUTUBE_SECOND_DESCRIPTION on Render — this module reads it at import time.
 */

// Kept short but meaningful — a real channel can override this via env.
// Under YouTube's 5,000-char description cap with plenty of headroom.
const FALLBACK_DESCRIPTION =
  "Uploaded via Command Center. Follow for more.";

export const DESCRIPTION: string =
  process.env.YOUTUBE_SECOND_DESCRIPTION ?? FALLBACK_DESCRIPTION;

// No tags by default — tags have marginal SEO value and would just be
// another thing to keep in sync.
export const TAGS: readonly string[] = [];

// "People & Blogs" — generic enough to fit anything without being wrong.
// Category IDs are documented at:
// https://developers.google.com/youtube/v3/docs/videoCategories/list
export const CATEGORY_ID = "22";

// "private" is mandatory whenever status.publishAt is set. YouTube auto-
// flips it to "public" at the scheduled timestamp — we rely on that.
export const PRIVACY_STATUS = "private" as const;

// selfDeclaredMadeForKids is legally required. Our content is not for kids.
export const MADE_FOR_KIDS = false;

// "youtube" = standard YouTube License (the alternative is creativeCommon).
export const LICENSE = "youtube" as const;

// Allow embedding + show public view counts — standard defaults for
// organic content.
export const EMBEDDABLE = true;
export const PUBLIC_STATS_VIEWABLE = true;

// Language metadata improves recommendations.
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_AUDIO_LANGUAGE = "en";

// Build-time sanity: keep the description under YouTube's cap. We check at
// module load so a misconfigured env var fails the deploy, not a user upload.
if (DESCRIPTION.length > 5000) {
  throw new Error(
    `YOUTUBE_SECOND_DESCRIPTION is ${DESCRIPTION.length} chars — YouTube's cap is 5000.`,
  );
}
