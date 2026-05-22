-- Seed an Instagram quote-card template row.
--
-- Until today the Instagram feed image post reused the Facebook PNG
-- bytes (1080×1080 square) via cron/_tweet_card_legs.py fan-out. The
-- operator wants Instagram to ship a taller 1080×1440 portrait (3:4)
-- so there's more vertical dead space to play with later. We give
-- Instagram its own template row instead of an in-code height override
-- so the height (and any future tweaks) can be tuned via the template
-- designer UI without a deploy.
--
-- Design parity with Facebook's row: same colors, fonts, padding,
-- header. The only intentional delta is `height: 1440` (3:4 portrait
-- vs FB's 1:1). Note that Instagram's documented max portrait aspect
-- is 4:5 (1080×1350); 3:4 may be cropped by the IG client at display
-- time — accepted trade-off for the extra vertical room.
--
-- `platform_enum` already includes 'instagram' (see
-- 20260412105430_initial_schema.sql), so no enum change is needed.
-- The partial index `idx_templates_platform` covers this row
-- automatically since is_active defaults to true.

INSERT INTO templates (platform, name, config) VALUES (
  'instagram',
  'Default Quote Card',
  '{
    "width": 1080,
    "height": 1440,
    "backgroundColor": "#ffffff",
    "textColor": "#1a1a1a",
    "accentColor": "#3b82f6",
    "maxFontSize": 120,
    "minFontSize": 24,
    "fontFamily": "Libre Franklin",
    "paddingTop": 40,
    "paddingRight": 85,
    "paddingBottom": 40,
    "paddingLeft": 85,
    "showHeader": true,
    "headerHeight": 240,
    "headerGap": 0,
    "headerMinScale": 0.2,
    "letterSpacing": -2,
    "lineHeight": 1.2,
    "paragraphSpacing": 0.5,
    "textAlign": "left",
    "showAccentBar": false,
    "accentBarPosition": "top",
    "accentBarThickness": 6
  }'::jsonb
);
