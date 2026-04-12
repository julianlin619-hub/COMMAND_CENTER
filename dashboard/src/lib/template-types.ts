/**
 * Shared template configuration type for content generation.
 *
 * Used by the square image renderer, template designer, preview route,
 * and template API routes. Keeping it in one place prevents drift
 * between the designer UI and the renderer.
 */

export interface TemplateConfig {
  width: number;
  height: number;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  maxFontSize: number;
  minFontSize: number;
  fontFamily: string;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  showHeader: boolean;
  headerHeight: number;
  headerGap: number;
  headerMinScale: number;
  letterSpacing: number;
  /** Line height multiplier for text lines (1.0 = tight, 1.4 = normal, 2.0 = double-spaced) */
  lineHeight: number;
  /** Multiplier for blank-line height relative to normal line height (0 = collapse, 1 = same as text line) */
  paragraphSpacing: number;
  textAlign: "left" | "center" | "right";
  showAccentBar: boolean;
  accentBarPosition: "top" | "bottom" | "left";
  accentBarThickness: number;
}

/**
 * Validate and clamp a raw config object from the database to safe values.
 * Invalid fields are silently dropped (the DEFAULT_TEMPLATE_CONFIG fill-in
 * will apply). This prevents malformed DB data from crashing the renderer.
 */
export function validateTemplateConfig(
  raw: Record<string, unknown>
): Partial<TemplateConfig> {
  const result: Partial<TemplateConfig> = {};

  // Numeric fields: must be finite and within reasonable bounds
  const numericFields: [keyof TemplateConfig, number, number][] = [
    ["width", 100, 4096],
    ["height", 100, 4096],
    ["maxFontSize", 8, 500],
    ["minFontSize", 8, 500],
    ["paddingTop", 0, 1000],
    ["paddingRight", 0, 1000],
    ["paddingBottom", 0, 1000],
    ["paddingLeft", 0, 1000],
    ["headerHeight", 0, 2000],
    ["headerGap", -500, 500],
    ["headerMinScale", 0, 1],
    ["letterSpacing", -20, 20],
    ["lineHeight", 0.5, 5],
    ["paragraphSpacing", 0, 5],
    ["accentBarThickness", 0, 100],
  ];
  for (const [key, min, max] of numericFields) {
    if (key in raw) {
      const val = Number(raw[key]);
      if (Number.isFinite(val)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result as any)[key] = Math.max(min, Math.min(max, val));
      }
    }
  }

  // Color fields: must match hex pattern
  const hexPattern = /^#[0-9a-fA-F]{3,8}$/;
  for (const key of ["backgroundColor", "textColor", "accentColor"] as const) {
    if (key in raw && typeof raw[key] === "string" && hexPattern.test(raw[key] as string)) {
      result[key] = raw[key] as string;
    }
  }

  // String enum fields
  if (raw.textAlign && ["left", "center", "right"].includes(raw.textAlign as string)) {
    result.textAlign = raw.textAlign as "left" | "center" | "right";
  }
  if (raw.accentBarPosition && ["top", "bottom", "left"].includes(raw.accentBarPosition as string)) {
    result.accentBarPosition = raw.accentBarPosition as "top" | "bottom" | "left";
  }

  // Boolean fields
  if (typeof raw.showHeader === "boolean") result.showHeader = raw.showHeader;
  if (typeof raw.showAccentBar === "boolean") result.showAccentBar = raw.showAccentBar;

  // Font family: alphanumeric + spaces/hyphens only (no script injection)
  if (typeof raw.fontFamily === "string" && /^[a-zA-Z0-9 _-]+$/.test(raw.fontFamily)) {
    result.fontFamily = raw.fontFamily;
  }

  return result;
}

/** Default config matching the seeded migration row — used by "Reset to Default" in the designer */
export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = {
  width: 1080,
  height: 1080,
  backgroundColor: "#ffffff",
  textColor: "#1a1a1a",
  accentColor: "#3b82f6",
  maxFontSize: 120,
  minFontSize: 24,
  fontFamily: "Libre Franklin",
  paddingTop: 40,
  paddingRight: 85,
  paddingBottom: 40,
  paddingLeft: 85,
  showHeader: true,
  headerHeight: 240,
  headerGap: 0,
  headerMinScale: 0.2,
  letterSpacing: -2,
  lineHeight: 1.2,
  paragraphSpacing: 0.5,
  textAlign: "left",
  showAccentBar: false,
  accentBarPosition: "top",
  accentBarThickness: 6,
};
