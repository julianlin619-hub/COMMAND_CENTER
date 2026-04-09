/**
 * Zernio API client for scheduling Instagram posts.
 *
 * Zernio (zernio.com) is a social media scheduling service. Instead of posting
 * directly to Instagram's Graph API (which requires complex container creation
 * and publishing steps), we upload the video to Zernio's storage and let Zernio
 * handle the Instagram posting via its queue system.
 *
 * Flow:
 *   1. getInstagramAccount() — find the connected IG account in Zernio
 *   2. uploadVideoToZernio() — get a presigned URL, upload the MP4
 *   3. scheduleVideoToInstagram() — create a post in Zernio's queue
 *
 * Requires ZERNIO_API_KEY env var.
 */

import fs from 'fs';

const ZERNIO_API_URL = 'https://zernio.com/api/v1';
const INSTAGRAM_CAPTION_LIMIT = 2200;

function getApiKey(): string {
  const apiKey = process.env.ZERNIO_API_KEY;
  if (!apiKey) throw new Error('ZERNIO_API_KEY env var not set');
  return apiKey;
}

function truncateCaption(text: string): string {
  if (text.length <= INSTAGRAM_CAPTION_LIMIT) return text;
  return text.slice(0, INSTAGRAM_CAPTION_LIMIT - 1).trimEnd() + '\u2026';
}

export async function getInstagramAccount(): Promise<{ accountId: string; profileId: string }> {
  const res = await fetch(`${ZERNIO_API_URL}/accounts`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zernio API error listing accounts: ${res.status} — ${body}`);
  }

  const { accounts } = (await res.json()) as {
    accounts: { _id: string; platform: string; profileId: { _id: string } }[];
  };

  const ig = accounts.find((a) => a.platform === 'instagram');
  if (!ig) {
    throw new Error('No Instagram account connected in Zernio. Connect Instagram at zernio.com first.');
  }
  return { accountId: ig._id, profileId: ig.profileId._id };
}

async function uploadVideoToZernio(videoPath: string): Promise<string> {
  const presignRes = await fetch(`${ZERNIO_API_URL}/media/presign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ filename: 'reel.mp4', contentType: 'video/mp4' }),
  });

  if (!presignRes.ok) {
    const body = await presignRes.text();
    throw new Error(`Zernio presign error: ${presignRes.status} — ${body}`);
  }

  const { uploadUrl, publicUrl } = (await presignRes.json()) as {
    uploadUrl: string;
    publicUrl: string;
  };

  const videoBuffer = fs.readFileSync(videoPath);

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: videoBuffer,
  });

  if (!uploadRes.ok) {
    const uploadBody = await uploadRes.text();
    throw new Error(`Failed to upload video to Zernio storage: ${uploadRes.status} — ${uploadBody}`);
  }

  return publicUrl;
}

export async function scheduleVideoToInstagram(
  accountId: string,
  profileId: string,
  tweetText: string,
  videoPath: string
): Promise<{ id: string }> {
  const zernioMediaUrl = await uploadVideoToZernio(videoPath);

  const res = await fetch(`${ZERNIO_API_URL}/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      content: truncateCaption(tweetText),
      queuedFromProfile: profileId,
      platforms: [{ platform: 'instagram', accountId }],
      mediaItems: [{ url: zernioMediaUrl, type: 'video' }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zernio API error creating post: ${res.status} — ${body}`);
  }

  const { post } = (await res.json()) as { post: { _id: string } };
  if (!post?._id) throw new Error('Unexpected response from Zernio API — no post ID returned');
  return { id: post._id };
}
