/**
 * Buffer GraphQL API client for TikTok video posting.
 *
 * Sends generated TikTok videos to Buffer's posting queue. Buffer handles
 * the actual TikTok API interaction (upload, publishing, queue timing).
 *
 * Ported from TWEEL_REEL's lib/buffer.ts with these changes:
 *   - Uses BUFFER_ACCESS_TOKEN (not BUFFER_API — same key, standardized name)
 *   - Uses BUFFER_ORG_ID env var instead of hardcoded organization ID
 *   - Typed response handling with proper error union matching
 *
 * Auth: BUFFER_ACCESS_TOKEN env var as Bearer token
 * Org:  BUFFER_ORG_ID env var to discover the TikTok channel
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
  });

  if (!res.ok) {
    throw new Error(`Buffer API error: ${res.status} ${res.statusText}`);
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
 * Look up the TikTok channel ID for a Buffer organization.
 * Queries Buffer's channels endpoint and finds the one with service='tiktok'.
 */
export async function getTikTokChannelId(
  orgId?: string
): Promise<string> {
  const org = orgId || process.env.BUFFER_ORG_ID;
  if (!org) throw new Error("BUFFER_ORG_ID env var not set");

  const data = await bufferRequest<{
    channels: { id: string; service: string; name: string }[];
  }>(`
    query GetChannels {
      channels(input: { organizationId: "${org}" }) {
        id
        service
        name
      }
    }
  `);

  const channel = data.channels.find((c) => c.service === "tiktok");
  if (!channel) {
    throw new Error(
      "No TikTok channel connected in Buffer. Connect TikTok at buffer.com first."
    );
  }
  return channel.id;
}

/**
 * Send a video to Buffer's TikTok posting queue.
 *
 * Creates a Buffer post with:
 *   - schedulingType: automatic (Buffer picks the next available time slot)
 *   - mode: addToQueue (appends to queue, doesn't post immediately)
 *   - videos: [{url}] (Buffer downloads the video from our signed URL)
 *
 * Returns the Buffer post ID on success.
 */
export async function sendToBuffer(
  channelId: string,
  caption: string,
  videoUrl: string
): Promise<string> {
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
    {
      input: {
        channelId,
        schedulingType: "automatic",
        mode: "addToQueue",
        text: truncateCaption(caption),
        assets: {
          videos: [{ url: videoUrl }],
        },
      },
    }
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
