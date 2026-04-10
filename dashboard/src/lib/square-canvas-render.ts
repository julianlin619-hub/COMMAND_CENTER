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
export async function renderSquareQuoteCard(
  text: string,
  config: TemplateConfig
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
      headerImg = await loadImage(
        path.join(process.cwd(), "public/ig-pipeline/Header.png")
      );
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

  let bestFontSize = config.minFontSize;
  let bestLines: string[] = [];

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
    const totalBlockHeight = scaledH + (headerImg ? config.headerGap : 0) + textHeight;

    if (totalBlockHeight <= maxContentHeight || fontSize === config.minFontSize) {
      bestFontSize = fontSize;
      bestLines = lines;
      break;
    }
  }

  // 5. Compute final header dimensions for the chosen font size
  const { h: headerDrawHeight, w: headerDrawW } = scaledHeaderForFont(bestFontSize);

  // 6. Vertically center the entire block (header + gap + text) on the canvas
  const lineHeight = bestFontSize * lineHeightMult;
  const textHeight = calcTextHeight(bestLines, lineHeight);
  const totalBlockHeight = headerDrawHeight + (headerImg ? config.headerGap : 0) + textHeight;
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

  return canvas.toBuffer("image/png");
}
