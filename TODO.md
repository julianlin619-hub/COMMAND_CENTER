# TODO

## Next Steps

- Manual uploader (batch drag all) - and automatically does title (based on prompt + transcript, and caption)
- ffmpeg extract audio -> deepgram API -> caption RAG + title LLM generator 
 
- Highlights channel - RAG title generation

- TikTok Carousels with tweets automation

- Create ongonig tweet supabase -> with tweets being added to it daily -> then automation can just pull fromt he database with one automation

- [ ] YouTube community post automation (playwright)

- [ ] YT long form video editor - adds CTA (pre edited) + banner 

- [ ] IG way to trim down hotlines / Q&As - cut each CAM to each individual biz owner. Directly ffmpeg input and output mp4. And then later down the line use remotion to splice both together 
- Then subset of that is be able to screen for clips that are high TAM and select them out (and clipper would produce descript cut)
- Down the line captions on Q&A content 

## Backlog

- [ ] Add data insights tracker from Buffer

 [ ] Instagram repost automation (download via scraper)
  - Scraper -> Topaz + Audio podcast -> Buffer

- [ ] YouTube podcasts? cross post via API? (need to edit)

- ACQ MCP + cron job

- RAG system to match captions with tweets + come up with titles (so all that's needed on tiktok manual is to upload video) - DO THIS but with normal wiki

- Repost automation (playwright -> IG spreadsheet -> 6 months > 500K Q&A -> 4K video downloader -> upload)
- Then bonus is repost in different visual format

- Crosspost fully automated (or just manually download all videos -> it automatically filters based on hotline or Q&A -> schedules via Buffer? Or playwright)

- Carousel automation
for multiple slides - vector database
https://acquisition.clickup.com/90131181233/docs/2ky3tbnh-20593/2ky3tbnh-5973

- Playwright MCP server to control mouse and schedule instagram (via meta biz suite - pull from monday.com)
- Explore Resolve MCP to directly edit on Davinci
- For highlights channel chop Q&A down into segments 
- Repost automation (download every into big backlog -> then randomly pick)
- Statics carousels - Reformat high QA performers and rescript them

- Turn youtube video into blog post / linkedln posts / twitter threads/ audio podcast 


work on claude outputting more meanigniful reuslts- structured outputs e.g .json format etc
- Clipper tool teach it to have understand context eg no random sentences or phrases - only full sentences or hey words so it’s not piecing together random strings

- Claude premiere plugin

- some rag system where we have all videos -> able to find reposts 

- YouTube repost automatino (with all videos downloaded)






YouTube Outlier Tool: (finds title outliers and thumbnail text - and then you can have a bank / vector da base)
I'm building a Next.js 14 (App Router) web app called YouTube Outlier Finder. It scans a YouTube channel, finds videos that dramatically outperformed the channel's typical views, and exports results to Google Sheets.
Help me design and build the backend only (no frontend work yet). Here's what I need:
Two API routes:

POST /api/scan — accepts { channel, mode: "last200" | "all", contentType: "longform" | "shorts" } and returns ranked outlier videos.
POST /api/export — accepts the scan results + channel name, appends them to a master Google Sheet.

Scan logic:

Normalize the channel input (URL, @handle, or bare handle) and resolve it via YouTube Data API (channels.list?forHandle=).
Get the uploads playlist (swap UC → UU in the channel ID).
Paginate playlistItems.list (50/page) to collect video IDs.
Batch videos.list (50/call) to get view counts + ISO 8601 durations.
Parse durations to seconds, filter by content type (long-form > 60s, Shorts ≤ 60s).
If mode is last200, take the 200 most recent of the filtered type.
Sort chronologically (oldest first). For each video, compute the median view count of the 20 videos immediately before it (same content type only). outlier_score = views / median. If fewer than 20 prior exist, use what's available and flag as limitedBaseline: true. Skip 0-view videos from results but include in baselines.
Keep only score ≥ 2x, sort descending.
For each result, call the Claude API (claude-sonnet-4-6) to extract a title format pattern. Batch in groups of 20, max 3 concurrent calls. The user-provided system prompt will be passed in — leave it as a configurable constant for now.
Return { channel, results: [{ title, url, views, score, publishedAt, titleFormat, limitedBaseline }] }.

Export logic:

Authenticate with Google Sheets API using a service account (JSON base64-encoded in env).
Open spreadsheet by ID from env.
Append a divider row: --- {channelName} | Scanned {ISO timestamp} ---
Append data rows with the 6 columns above.
Apply minimal formatting: bold header, auto column widths, conditional color on score column (2–5x blue, 5–10x amber, 10x+ red).

Project structure:
/app/api/scan/route.ts
/app/api/export/route.ts
/lib/youtube.ts       — handle parsing, channel resolution, paginated fetch, duration parser
/lib/scoring.ts       — pure functions for median + scoring
/lib/title-format.ts  — Claude client, batching, concurrency limiter
/lib/sheets.ts        — Google auth + append + formatting
Env vars: YOUTUBE_API_KEY, ANTHROPIC_API_KEY, GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT (base64 JSON).
Constraints:

TypeScript throughout.
Wrap every external API call in try/catch; return clear error messages (invalid handle, quota exceeded, Claude failure, Sheets auth failure).
Keep scoring logic in pure functions so it's easy to unit test.
No caching, no database, no auth in v1.

Start by scaffolding the file structure and the youtube.ts + scoring.ts modules. Walk me through your approach before writing code.