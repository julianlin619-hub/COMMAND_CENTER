# TODO

## Next Steps

- [ ] YouTube highlights automation (upload to supabase video file + title -> post via YouTube API highlights - schedules 10 per day max - )

- [ ] TikTok + YTS + LI (repost automation). Basically upload files directly to supabase / storage with captions -> and it posts on all platforms. Or down the line it reads all tweets in database and finds matching content. Or maybe just simplfy captions a lot if it's even needed. 

- [ ] Repost old YouTube Shorts to YouTube Shorts + TikTok + LI (maybe via monday.com automation / frame - all upload onto same frame and automation can work there)
  - Scan a file of old uploads for MP4s
  - Download MP4 files and re-upload via Buffer
  - Post to both YouTube Shorts and TikTok


- [ ] Daily LinkedIn scheduler with outlier tweet reel (same as Facebook flow)
  - Pick from recent outlier tweet reels
  - Schedule once daily to LinkedIn


- [ ] Instagram repost automation (download via scraper)
  - Scraper downloads source Instagram posts
  - Auto-repost pipeline through Buffer

- [ ] Topaz API integration to upscale 720p -> 4K
  - Natural settings baseline:
    - `model=prob-4` (Proteus v4)
    - `w=3840:h=2160`
    - `sharpen=0.15` (~15/100)
    - `noise=0.05` to `0.10`
    - `blur=0.05` to `0.10`
    - `compression=0.05` to `0.10`
    - `details=0.20` (recover detail)
    - `halo=0.05` to `0.10`

- [ ] Audio podcast pipeline (audio-only content)

- [ ] YouTube community post automation

## Backlog

- [ ] Add data insights tracker from Buffer
