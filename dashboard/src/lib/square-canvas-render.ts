/**
 * Square quote card renderer for Facebook.
 *
 * Renders tweet text onto a 1080x1080 PNG canvas with configurable design
 * (colors, accent bar, header image, typography). Configuration comes from
 * the templates table in Supabase, so users can tweak the design in the
 * template designer without changing code.
 *
 * Uses the same lazy-load canvas pattern and font as the existing TikTok
 * renderer (canvas-render.ts) — both register 'Libre Franklin' from the
 * same .otf file.
 *
 * NOTE: The `canvas` npm package requires native libs (libcairo, etc.).
 * This module lazy-loads it so the dashboard can build without it.
 */

import path from "path";
import type { TemplateConfig } from "@/lib/template-types";

// Lazy-load node-canvas to avoid crashing environments where it's not installed.
// The font is registered once on first use.
let canvasModule: typeof import("canvas") | null = null;
let fontRegistered = false;

async function getCanvas() {
  if (!canvasModule) {
    canvasModule = await import("canvas");
  }
  if (!fontRegistered) {
    canvasModule.registerFont(
      path.join(
        process.cwd(),
        "public/ig-pipeline/fonts/LibreFranklin-Regular.otf"
      ),
      { family: "Libre Franklin", weight: "400" }
    );
    fontRegistered = true;
  }
  return canvasModule;
}

/** Measure text width accounting for letter spacing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function measureText(ctx: any, text: string, letterSpacing: number): number {
  return ctx.measureText(text).width + letterSpacing * Math.max(0, text.length - 1);
}

/** Draw text character by character with letter spacing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fillTextWithSpacing(ctx: any, text: string, x: number, y: number, letterSpacing: number): void {
  if (letterSpacing === 0) {
    ctx.fillText(text, x, y);
    return;
  }
  let currentX = x;
  for (const char of text) {
    ctx.fillText(char, currentX, y);
    currentX += ctx.measureText(char).width + letterSpacing;
  }
}

/** Word-wrap text into lines that fit within maxWidth, accounting for letter spacing. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  letterSpacing: number = 0
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let currentLine = "";
    for (const word of paragraph.split(" ")) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (measureText(ctx, candidate, letterSpacing) > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines;
}

/**
 * Render a square quote card PNG from tweet text and a template config.
 *
 * The algorithm:
 *   1. Fill background
 *   2. Draw accent bar (if enabled)
 *   3. Draw header image (if enabled)
 *   4. Auto-size text from maxFontSize down to minFontSize until it fits
 *   5. Draw centered/aligned text in the remaining space
 *
 * Returns a PNG Buffer ready for upload to Supabase Storage.
 */
export interface RenderOptions {
  /**
   * Override the header image with raw bytes instead of loading the
   * default Header.png from disk. Used by the design sandbox so an
   * operator can preview a candidate header image before any of it
   * is committed to disk or wired into the cron.
   *
   * Pass a Buffer of a decoded PNG/JPEG/etc. — node-canvas's
   * `loadImage` accepts Buffers directly.
   */
  headerImageBuffer?: Buffer;
  /**
   * Draw a red "SWIPE →" pill badge below the text. Used by the
   * Instagram carousel pipeline's title card (slide 1) to signal the
   * post is a carousel. The badge participates in the auto-fit layout:
   * its height is reserved before the text sizing loop runs, and the
   * whole block (header + text + badge) is vertically centered together.
   */
  swipeBadge?: boolean;
}

// ── Swipe badge geometry ────────────────────────────────────────────────
// Sized for the 1080-wide canvas. The pill mimics the reference design:
// saturated red rounded-full pill, white uppercase text, right arrow.
// Only the 400-weight Libre Franklin file is registered, so the "bold"
// look comes from stroking the text with its own fill color.
const SWIPE_BADGE = {
  height: 96,
  paddingX: 44,
  gapAboveBadge: 64, // space between the last text line and the pill
  fontSize: 46,
  letterSpacing: 3,
  // Matches the verified-checkmark blue in Header.png (sampled dominant
  // pixel), so the pill reads as part of the tweet card rather than an
  // external CTA color.
  color: "#4A99EE",
  textColor: "#ffffff",
  label: "SWIPE",
  // Hand-drawn arrow (not the "→" glyph — Libre Franklin's arrow is thin
  // and inconsistent across weights; drawing it keeps it chunky like the
  // reference).
  arrowLength: 52,
  arrowHead: 14,
  arrowStroke: 7,
  gapTextArrow: 22, // space between "SWIPE" and the arrow
};

/** Total vertical space the swipe badge adds to the content block. */
function swipeBadgeBlockHeight(): number {
  return SWIPE_BADGE.gapAboveBadge + SWIPE_BADGE.height;
}

/**
 * Draw the "SWIPE →" pill. `x` is the pill's left edge, `y` its top.
 * Returns nothing — pure canvas drawing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawSwipeBadge(ctx: any, x: number, y: number): number {
  const b = SWIPE_BADGE;
  ctx.save();

  ctx.font = `400 ${b.fontSize}px "Libre Franklin"`;
  const labelWidth = measureText(ctx, b.label, b.letterSpacing);
  const pillWidth =
    b.paddingX * 2 + labelWidth + b.gapTextArrow + b.arrowLength;

  // Rounded-full pill (radius = half height).
  const r = b.height / 2;
  ctx.fillStyle = b.color;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + pillWidth - r, y);
  ctx.arc(x + pillWidth - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + b.height);
  ctx.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2);
  ctx.closePath();
  ctx.fill();

  // Label — fill + stroke in the same color to fake a bold weight from
  // the single 400-weight font file.
  const centerY = y + b.height / 2;
  ctx.fillStyle = b.textColor;
  ctx.strokeStyle = b.textColor;
  ctx.lineWidth = 2.5;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let cx = x + b.paddingX;
  for (const char of b.label) {
    ctx.fillText(char, cx, centerY);
    ctx.strokeText(char, cx, centerY);
    cx += ctx.measureText(char).width + b.letterSpacing;
  }

  // Arrow: shaft + open chevron head, drawn after the label.
  const shaftStart = x + b.paddingX + labelWidth + b.gapTextArrow;
  const shaftEnd = shaftStart + b.arrowLength;
  ctx.lineWidth = b.arrowStroke;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(shaftStart, centerY);
  ctx.lineTo(shaftEnd, centerY);
  ctx.moveTo(shaftEnd - b.arrowHead, centerY - b.arrowHead);
  ctx.lineTo(shaftEnd, centerY);
  ctx.lineTo(shaftEnd - b.arrowHead, centerY + b.arrowHead);
  ctx.stroke();

  ctx.restore();
  return pillWidth;
}

export async function renderSquareQuoteCard(
  text: string,
  config: TemplateConfig,
  options: RenderOptions = {}
): Promise<Buffer> {
  const { createCanvas, loadImage } = await getCanvas();
  const canvas = createCanvas(config.width, config.height);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = canvas.getContext("2d") as any;

  // 1. Background fill
  ctx.fillStyle = config.backgroundColor;
  ctx.fillRect(0, 0, config.width, config.height);

  // 2. Accent bar (optional colored strip along one edge)
  if (config.showAccentBar) {
    ctx.fillStyle = config.accentColor;
    const t = config.accentBarThickness;
    switch (config.accentBarPosition) {
      case "top":
        ctx.fillRect(0, 0, config.width, t);
        break;
      case "bottom":
        ctx.fillRect(0, config.height - t, config.width, t);
        break;
      case "left":
        ctx.fillRect(0, 0, t, config.height);
        break;
    }
  }

  // 3. Load header image and compute its aspect ratio (don't draw yet — need vertical offset first)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let headerImg: any = null;
  let headerAspectRatio = 0; // height / width of the original image
  if (config.showHeader) {
    try {
      // Caller-supplied bytes win over the on-disk default — this is how
      // the design sandbox previews a candidate header without writing it.
      const source = options.headerImageBuffer
        ? options.headerImageBuffer
        : path.join(process.cwd(), "public/ig-pipeline/Header.png");
      headerImg = await loadImage(source);
      headerAspectRatio = headerImg.height / headerImg.width;
    } catch {
      headerImg = null;
    }
  }

  // Helper: compute scaled header height for a given font size.
  // The header shrinks proportionally as font size decreases, so short text
  // gets a big header and long text gets a smaller one — keeping them balanced.
  //   fontRatio = 1.0 at maxFontSize → full headerHeight
  //   fontRatio = 0.0 at minFontSize → 20% of headerHeight (floor)
  const minHeaderH = config.headerHeight * config.headerMinScale;
  function scaledHeaderForFont(fontSize: number): { h: number; w: number } {
    if (!headerImg) return { h: 0, w: 0 };
    const fontRange = config.maxFontSize - config.minFontSize;
    const fontRatio = fontRange > 0 ? (fontSize - config.minFontSize) / fontRange : 1;
    const maxH = Math.min(
      (config.width - config.paddingLeft - config.paddingRight) * headerAspectRatio,
      config.headerHeight
    );
    const h = minHeaderH + fontRatio * (maxH - minHeaderH);
    const w = h / headerAspectRatio;
    return { h, w };
  }

  // 4. Auto-size text to fit within the canvas (header scales with font)
  const maxTextWidth = config.width - config.paddingLeft - config.paddingRight;
  const lineHeightMult = config.lineHeight ?? 1.4;
  const paragraphMult = config.paragraphSpacing ?? 0.5;
  const maxContentHeight = config.height - config.paddingTop - config.paddingBottom;

  // Calculate total text height accounting for blank lines using paragraphSpacing
  function calcTextHeight(lines: string[], lineHeight: number): number {
    let h = 0;
    for (const line of lines) {
      h += line === "" ? lineHeight * paragraphMult : lineHeight;
    }
    return h;
  }

  // Seed the fallback with minFontSize's wrapped lines BEFORE the shrink
  // loop. This matters for two edge cases:
  //   1. maxFontSize < minFontSize (misconfigured template) — loop doesn't run
  //   2. minFontSize parity mismatch with `-= 2` step (e.g. max=120, min=25)
  //      — the loop skips right past minFontSize without setting bestLines,
  //      and we'd render a blank card.
  // Seeding guarantees we always have non-empty lines, even if the text
  // never fits cleanly. Overflow at the absolute minimum size is acceptable;
  // a blank card silently published to Facebook is not.
  let bestFontSize = config.minFontSize;
  ctx.font = `400 ${config.minFontSize}px "Libre Franklin"`;
  let bestLines = wrapText(ctx, text, maxTextWidth, config.letterSpacing);

  // The swipe badge (title-card slides) reserves its space up front so the
  // auto-fit loop can never size text into the pill's footprint.
  const badgeBlockH = options.swipeBadge ? swipeBadgeBlockHeight() : 0;

  for (
    let fontSize = config.maxFontSize;
    fontSize >= config.minFontSize;
    fontSize -= 2
  ) {
    ctx.font = `400 ${fontSize}px "Libre Franklin"`;
    const lines = wrapText(ctx, text, maxTextWidth, config.letterSpacing);
    const lineHeight = fontSize * lineHeightMult;
    const textHeight = calcTextHeight(lines, lineHeight);
    const { h: scaledH } = scaledHeaderForFont(fontSize);
    const totalBlockHeight =
      scaledH + (headerImg ? config.headerGap : 0) + textHeight + badgeBlockH;

    if (totalBlockHeight <= maxContentHeight) {
      bestFontSize = fontSize;
      bestLines = lines;
      break;
    }
  }

  // 5. Compute final header dimensions for the chosen font size
  const { h: headerDrawHeight, w: headerDrawW } = scaledHeaderForFont(bestFontSize);

  // 6. Vertically center the entire block (header + gap + text + badge)
  const lineHeight = bestFontSize * lineHeightMult;
  const textHeight = calcTextHeight(bestLines, lineHeight);
  const totalBlockHeight =
    headerDrawHeight + (headerImg ? config.headerGap : 0) + textHeight + badgeBlockH;
  const blockTopY = (config.height - totalBlockHeight) / 2;

  // 7. Draw header image at the top of the centered block (left-aligned)
  if (headerImg) {
    ctx.drawImage(headerImg, config.paddingLeft, blockTopY, headerDrawW, headerDrawHeight);
  }

  // 8. Draw text right after header + gap
  const textStartY = blockTopY + headerDrawHeight + (headerImg ? config.headerGap : 0) + bestFontSize;

  ctx.fillStyle = config.textColor;
  ctx.font = `400 ${bestFontSize}px "Libre Franklin"`;
  ctx.textBaseline = "alphabetic";

  let cumulativeY = 0;
  for (let i = 0; i < bestLines.length; i++) {
    const line = bestLines[i];
    const y = textStartY + cumulativeY;

    if (line !== "") {
      // Calculate x position based on text alignment
      let x: number;
      if (config.textAlign === "center") {
        ctx.textAlign = "center";
        x = config.width / 2;
      } else if (config.textAlign === "right") {
        ctx.textAlign = "right";
        x = config.width - config.paddingRight;
      } else {
        ctx.textAlign = "left";
        x = config.paddingLeft;
      }

      fillTextWithSpacing(ctx, line, x, y, config.letterSpacing);
      cumulativeY += lineHeight;
    } else {
      // Blank line — use paragraph spacing multiplier
      cumulativeY += lineHeight * paragraphMult;
    }
  }

  // 9. Swipe badge (title-card slides) — below the text, aligned with it.
  // Left-aligned to paddingLeft like the header and (default) text, so the
  // whole card reads as one left-anchored column.
  if (options.swipeBadge) {
    const badgeTop =
      blockTopY +
      headerDrawHeight +
      (headerImg ? config.headerGap : 0) +
      textHeight +
      SWIPE_BADGE.gapAboveBadge;
    drawSwipeBadge(ctx, config.paddingLeft, badgeTop);
  }

  return canvas.toBuffer("image/png");
}
