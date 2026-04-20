# Next Steps

## In Progress
- [ ] 

## Up Next
- [ ] Daily tweetbank-to-TikTok+Facebook+LinkedIn cron job
  - Filter tweetbank for tweets with 6.5K+ likes
  - Randomly pick one qualifying tweet per day
  - Schedule it to TikTok, Facebook, and LinkedIn (same tweet for all three)
  - Runs once daily
- [ ] Repost old YouTube Shorts to YouTube Shorts + TikTok
  - Scan a file of old uploads for MP4s
  - Download MP4 files and re-upload via Buffer
  - Post to both YouTube Shorts and TikTok
- [ ] Daily Instagram scheduler for recent outlier tweets
  - Automatically schedule to Instagram via Buffer
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

## Done
- [x] Consolidate 6 platform repos into monorepo
- [x] Security hardening for multiplatform scaling
- [x] Facebook recent outlier reels + updated tweetbank
- [x] TikTok outlier tweet reels
- [x] Pause Instagram (2nd) cron, show Pending status
