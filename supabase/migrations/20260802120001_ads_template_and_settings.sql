-- Ad Carousels: seed the 'ads' template row and create the settings table.
-- (Consumes the 'ads' enum value added by the previous migration — enum
-- adds must be in their own transaction, so this is a separate file.)
--
-- 1. Template row: a byte-for-byte clone of the Instagram carousel's
--    current config (1080×1350 portrait after 20260723120001) so ad
--    slides start visually identical to IG carousel slides. Giving ads
--    its OWN row means styling can later diverge (colors, dimensions,
--    header) via the template designer / /api/templates without touching
--    the live Instagram carousels. The partial index idx_templates_platform
--    covers this row automatically (is_active defaults to true).
--
-- 2. ads_carousel_settings: singleton row holding the user-editable
--    default prompt and CTA copy shown on the /ads-carousels dashboard
--    page. These CANNOT live in templates.config — the template
--    designer's validateTemplateConfig strips unknown keys on save,
--    which would silently delete them. A dedicated one-row table is the
--    smallest thing that works (CHECK (id = 1) enforces the singleton).

INSERT INTO templates (platform, name, config) VALUES (
  'ads',
  'Ads Quote Card',
  '{
    "width": 1080,
    "height": 1350,
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

CREATE TABLE ads_carousel_settings (
    -- Singleton: exactly one row, always id = 1. The dashboard reads and
    -- updates this row directly; no history is kept (edit-in-place).
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    default_prompt TEXT NOT NULL DEFAULT '',
    cta_text TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Service-role-only access, like every other table (the anon key gets
-- nothing; all server code uses the service key which bypasses RLS —
-- the explicit policy documents intent and satisfies the advisor).
ALTER TABLE ads_carousel_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on ads_carousel_settings"
    ON ads_carousel_settings FOR ALL
    USING (auth.role() = 'service_role');

-- Seed the singleton so the dashboard can always UPDATE ... WHERE id = 1
-- without an upsert dance.
INSERT INTO ads_carousel_settings (id) VALUES (1);
