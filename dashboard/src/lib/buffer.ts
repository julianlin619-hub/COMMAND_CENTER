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
 */
export async function getChannelId(
  orgId: string | undefined,
  service: string
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

  const channel = data.channels.find((c) => c.service === service);
  if (!channel) {
    throw new Error(
      `No ${service} channel connected in Buffer. Connect ${service} at buffer.com first.`
    );
  }
  return channel.id;
}

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
  facebookPostType?: "post" | "story" | "reel"
): Promise<string> {
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
    text: truncateCaption(caption),
    assets,
  };
  // Facebook requires metadata.facebook.type — Buffer's schema nests
  // platform-specific fields under metadata, not on the top-level input.
  if (facebookPostType) {
    input.metadata = { facebook: { type: facebookPostType } };
  }

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
