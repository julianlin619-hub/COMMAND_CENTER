/**
 * Buffer GraphQL API client for multi-platform posting.
 *
 * Sends generated content (videos, images) to Buffer's posting queue.
 * Buffer handles the actual platform API interaction (upload, publishing,
 * queue timing).
 *
 * Supports any platform connected in Buffer — the `service` param selects
 * which channel to use ('tiktok', 'facebook', etc.).
 *
 * Auth: BUFFER_ACCESS_TOKEN env var as Bearer token
 * Org:  BUFFER_ORG_ID env var to discover platform channels
 */

const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";

/** TikTok's caption character limit */
const TIKTOK_CAPTION_LIMIT = 150;

/**
 * Send a GraphQL request to Buffer and return the data payload.
 * Throws on HTTP errors, auth errors, or GraphQL-level errors.
 */
async function bufferRequest<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) throw new Error("BUFFER_ACCESS_TOKEN env var not set");

  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    // Abort after 10s — without this a hung Buffer endpoint stalls the
    // serverless invocation until Next.js's much higher default kills it.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(
      `Buffer API error ${res.status}: ${errorBody || res.statusText}`
    );
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  return json.data as T;
}

/**
 * Truncate caption to TikTok's 150-character limit.
 * Appends a Unicode ellipsis (…) if truncated so it's clear the text was cut.
 */
export function truncateCaption(
  text: string,
  limit: number = TIKTOK_CAPTION_LIMIT
): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).trimEnd() + "\u2026";
}

/**
 * Look up a platform's channel ID in a Buffer organization.
 * Queries Buffer's channels endpoint and finds the one matching `service`.
 *
 * @param orgId - Buffer org ID. Defaults to BUFFER_ORG_ID env var.
 * @param service - Buffer service name: 'tiktok', 'facebook', etc.
 * @param name - Optional channel name (case-insensitive) to disambiguate
 *   when an org has multiple channels for the same service (e.g., two
 *   Instagram profiles). Without it, the first match wins.
 */
export async function getChannelId(
  orgId: string | undefined,
  service: string,
  name?: string
): Promise<string> {
  const org = orgId || process.env.BUFFER_ORG_ID;
  if (!org) throw new Error("BUFFER_ORG_ID env var not set");

  // Uses GraphQL variables (not string interpolation) to prevent injection.
  const data = await bufferRequest<{
    channels: { id: string; service: string; name: string }[];
  }>(
    `query GetChannels($orgId: OrganizationId!) {
      channels(input: { organizationId: $orgId }) {
        id
        service
        name
      }
    }`,
    { orgId: org }
  );

  const wantName = name?.toLowerCase();
  const channel = data.channels.find(
    (c) => c.service === service && (!wantName || c.name.toLowerCase() === wantName)
  );
  if (!channel) {
    const suffix = name ? ` named "${name}"` : "";
    throw new Error(
      `No ${service} channel${suffix} connected in Buffer. Connect ${service} at buffer.com first.`
    );
  }
  return channel.id;
}

// Full YouTube publisher metadata Buffer requires. Buffer surfaced a
// "YouTube posts require a category" InvalidInputError when only `title`
// was set, so we pass the full policy block on every YouTube call.
// Field names follow YouTube Data API's videos.insert snippet+status
// naming — adjust here if Buffer's schema rejects a specific key.
export type YouTubeMetadata = {
  title: string;
  // Numeric categoryId as a string. 27 = Education. Full list:
  // https://developers.google.com/youtube/v3/docs/videoCategories/list
  categoryId: string;
  privacy: "public" | "unlisted" | "private";
  // COPPA flag. Required on every upload since 2020.
  madeForKids: boolean;
  notifySubscribers: boolean;
  embeddable: boolean;
  license: "youtube" | "creativeCommon";
  // Omit entirely when empty — some publishers reject `[]`.
  tags?: string[];
};

export type SendToBufferOptions = {
  facebookPostType?: "post" | "story" | "reel";
  // Instagram requires metadata.instagram.type on every post. Reels also
  // need shouldShareToFeed=true to surface in the main feed (Buffer adds
  // that automatically when type === "reel").
  instagramPostType?: "post" | "story" | "reel";
  youtube?: YouTubeMetadata;
  // Overrides the caption truncation limit (default 150 for TikTok).
  // YouTube callers pass 5000 so descriptions aren't amputated.
  captionLimit?: number;
};

/**
 * Send content to Buffer's posting queue.
 *
 * Creates a Buffer post with:
 *   - schedulingType: automatic (Buffer picks the next available time slot)
 *   - mode: addToQueue (appends to queue, doesn't post immediately)
 *   - assets: videos or images based on mediaType
 *
 * Returns the Buffer post ID on success.
 */
export async function sendToBuffer(
  channelId: string,
  caption: string,
  mediaUrl: string,
  mediaType: "video" | "image" = "video",
  options: SendToBufferOptions = {}
): Promise<string> {
  const { facebookPostType, instagramPostType, youtube, captionLimit } = options;

  // Build assets payload based on media type.
  // Buffer's AssetsInput accepts: images, videos, documents, link
  const assets =
    mediaType === "image"
      ? { images: [{ url: mediaUrl }] }
      : { videos: [{ url: mediaUrl }] };

  const input: Record<string, unknown> = {
    channelId,
    schedulingType: "automatic",
    mode: "addToQueue",
    text: truncateCaption(caption, captionLimit ?? TIKTOK_CAPTION_LIMIT),
    assets,
  };
  // Buffer nests platform-specific fields under metadata, not on the
  // top-level input. Facebook: { facebook: { type } }. YouTube: the full
  // YouTubeMetadata block — title, categoryId, privacy, madeForKids, etc.
  const metadata: Record<string, unknown> = {};
  if (facebookPostType) metadata.facebook = { type: facebookPostType };
  if (instagramPostType) {
    // 1080x1920 vertical videos belong in the Reels tab; shouldShareToFeed
    // also pushes them into the main feed so they aren't only discoverable
    // via the Reels surface. Mirrors core/buffer.py:181-197.
    metadata.instagram = {
      type: instagramPostType,
      ...(instagramPostType === "reel" ? { shouldShareToFeed: true } : {}),
    };
  }
  if (youtube) {
    // Strip the optional `tags` key when empty/missing so Buffer doesn't
    // see `tags: []` (some publishers reject an empty array).
    const { tags, ...rest } = youtube;
    metadata.youtube = tags && tags.length > 0 ? { ...rest, tags } : rest;
  }
  if (Object.keys(metadata).length > 0) input.metadata = metadata;

  const data = await bufferRequest<{
    createPost: { post?: { id: string }; message?: string };
  }>(
    `mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post { id }
        }
        ... on NotFoundError { message }
        ... on UnauthorizedError { message }
        ... on UnexpectedError { message }
        ... on RestProxyError { message }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
      }
    }`,
    { input }
  );

  const result = data.createPost;
  if ("message" in result && result.message) {
    throw new Error(result.message);
  }
  if (!result.post) {
    throw new Error("Unexpected response from Buffer API");
  }
  return result.post.id;
}
