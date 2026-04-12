-- Templates table — stores per-platform design configurations for content generation.
-- Facebook uses this for square quote card layouts. TikTok still reads from
-- data/canvas-config.json (migrating it here is a separate follow-up).

CREATE TABLE templates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform platform_enum NOT NULL,
  name TEXT NOT NULL,
  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Partial index — only index active templates since that's the only query pattern
CREATE INDEX idx_templates_platform ON templates (platform) WHERE is_active = true;

-- Seed the default Facebook quote card template.
-- These values are the starting point — users can tweak them in the template designer.
INSERT INTO templates (platform, name, config) VALUES (
  'facebook',
  'Default Quote Card',
  '{
    "width": 1080,
    "height": 1080,
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
    "textAlign": "left",
    "showAccentBar": false,
    "accentBarPosition": "top",
    "accentBarThickness": 6
  }'::jsonb
);
