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
