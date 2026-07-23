-- Resize the Instagram quote-card template from 1080×1440 to 1080×1350.
--
-- The Instagram carousel pipeline renders its cards through the existing
-- 'instagram' template row (via /api/content-gen/generate). The operator
-- wants 1080×1350 — Instagram's documented max portrait aspect (4:5).
-- The old 1440 height (3:4) risked client-side cropping for a single
-- feed image; for a carousel it's worse, because IG forces one aspect
-- ratio across ALL slides, so any crop hits every card.
--
-- We UPDATE the existing row rather than inserting a carousel-specific
-- one: /api/content-gen/generate selects the template with
-- .eq('platform','instagram').eq('is_active',true).limit(1).single(),
-- so a second active instagram row would make template selection
-- nondeterministic. The only other consumer of this row is the legacy
-- IG_TWEET_CARD_FORMAT='image' fan-out mode, which is paused (default
-- 'off') — and would benefit from the crop-safe 4:5 anyway.
--
-- Keep in sync with DEFAULT_INSTAGRAM_TEMPLATE_CONFIG in
-- dashboard/src/lib/template-types.ts (the in-code fallback when the row
-- is missing or fails validation).
UPDATE templates
SET config = jsonb_set(config, '{height}', '1350'),
    updated_at = now()
WHERE platform = 'instagram' AND is_active = true;
