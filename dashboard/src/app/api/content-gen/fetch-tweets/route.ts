/**
 * POST /api/content-gen/fetch-tweets
 *
 * Scrapes outlier tweets (high-engagement) from a Twitter/X account via the
 * Apify "apidojo/tweet-scraper" actor. Used by the TikTok Outlier Tweet Reel
 * pipeline to find viral tweet content worth converting into short-form video.
 *
 * Body: { handle?: string, minLikes?: number, maxItems?: number }
 *   - handle:   Twitter/X username to scrape (defaults to APIFY_TWITTER_HANDLE env var)
 *   - minLikes: Minimum like count filter (default 4000)
 *   - maxItems: Max tweets to fetch from Apify (default 30)
 *
 * Returns: { tweets: [{ id, text, likeCount, createdAt, url, retweetCount }] }
 *
 * No file-based dedup here — the UI calls /api/content-gen/check-dupes separately
 * to flag tweets that already exist as TikTok posts in Supabase.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyApiAuth } from "@/lib/auth";

// Decode HTML entities that Apify sometimes returns in tweet text.
// e.g. &amp; → &, &#39; → ', etc.
function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "APIFY_API_KEY not configured" },
      { status: 500 }
    );
  }

  try {
    const body = await req.json();
    const handle = body.handle || process.env.APIFY_TWITTER_HANDLE || "AlexHormozi";
    const minLikes = body.minLikes ?? 4000;
    const maxItems = body.maxItems ?? 30;

    // Lazy-load apify-client (it's an optionalDependency — only installed
    // in environments where the content pipeline actually runs)
    const { ApifyClient } = await import("apify-client");
    const client = new ApifyClient({ token: apiKey });

    // Run the Apify tweet-scraper actor. This calls the Apify API, waits
    // for the scrape to finish, and returns a dataset ID we can read from.
    const { defaultDatasetId } = await client
      .actor("apidojo~tweet-scraper")
      .call({
        twitterHandles: [handle],
        maxItems,
        sort: "Latest",
        minimumFavorites: minLikes,
      });

    // Read the scraped tweets from the Apify dataset
    const { items } = await client.dataset(defaultDatasetId).listItems();
    const raw = items as Record<string, unknown>[];

    // Normalize each tweet into a clean shape, filter by minLikes,
    // and sort newest-first
    const tweets = raw
      .map((t) => ({
        id: String(t.id ?? ""),
        text: decodeHtml(String(t.text ?? "")),
        likeCount: Number(t.likeCount ?? 0),
        createdAt: String(t.createdAt ?? ""),
        url: String(t.url ?? ""),
        retweetCount: Number(t.retweetCount ?? 0),
      }))
      .filter((t) => t.text.trim() && t.likeCount >= minLikes)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

    return NextResponse.json({ tweets });
  } catch (err) {
    const error = err as { message?: string };
    console.error("Apify fetch-tweets error:", error.message);
    return NextResponse.json(
      { error: error.message || "Unknown error" },
      { status: 500 }
    );
  }
}
