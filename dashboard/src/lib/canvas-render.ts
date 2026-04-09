/**
 * Tweet-to-PNG image renderer using node-canvas.
 *
 * Takes tweet text and renders it onto a branded 1080x1920 canvas (Instagram
 * Reel / Story dimensions) with a header image and configurable typography.
 *
 * The layout automatically adjusts font size to fit the text within the
 * content area — longer tweets get smaller text, shorter ones get larger.
 * The algorithm tries sizes from maxFontSize down to minFontSize until the
 * text fits within the contentAreaHeight with adequate top padding.
 *
 * Configuration (font sizes, colors, spacing) is loaded from
 * data/canvas-config.json so you can tweak the design without changing code.
 *
 * NOTE: The `canvas` npm package is an optionalDependency — it requires native
 * libs (libcairo, etc.) that aren't available in every environment. This module
 * lazy-loads it so the dashboard can build and run without it. The pipeline
 * API routes that call renderTweetToBuffer() only run in GitHub Actions where
 * the native deps are installed.
 */

import path from 'path';
import fs from 'fs';

const FONT_WEIGHT = 400;
const W = 1080;
const H = 1920;

// Lazy-load node-canvas to avoid crashing environments where it's not installed.
// The font is registered once on first use.
let canvasModule: typeof import('canvas') | null = null;
let fontRegistered = false;

async function getCanvas() {
  if (!canvasModule) {
    canvasModule = await import('canvas');
  }
  if (!fontRegistered) {
    canvasModule.registerFont(
      path.join(process.cwd(), 'public/ig-pipeline/fonts/LibreFranklin-Regular.otf'),
      { family: 'Libre Franklin', weight: '400' }
    );
    fontRegistered = true;
  }
  return canvasModule;
}

interface CanvasConfig {
  minTopPadding: number;
  contentAreaHeight: number;
  maxFontSize: number;
  minFontSize: number;
  fontSizeStep: number;
  lineHeightMult: number;
  letterSpacing: number;
  blankLineRatio: number;
  gap: number;
  topOffset: number;
  headerX: number;
  headerWidth: number;
  textPaddingX: number;
  textRightBoundary: number;
  bgColor: string;
  textColor: string;
}

function getDataDir(): string {
  return process.env.TWEET_BANK_DATA_DIR || path.resolve(process.cwd(), '..', 'data');
}

function loadConfig(): CanvasConfig {
  const raw = fs.readFileSync(path.join(getDataDir(), 'canvas-config.json'), 'utf8');
  return JSON.parse(raw);
}

interface WrappedLine {
  text: string;
  isBlank: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function measureText(ctx: any, text: string, letterSpacing: number): number {
  return ctx.measureText(text).width + letterSpacing * Math.max(0, text.length - 1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fillTextWithSpacing(ctx: any, text: string, x: number, y: number, letterSpacing: number): void {
  let currentX = x;
  for (const char of text) {
    ctx.fillText(char, currentX, y);
    currentX += ctx.measureText(char).width + letterSpacing;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapTextToLines(ctx: any, text: string, maxWidth: number, letterSpacing: number): WrappedLine[] {
  const result: WrappedLine[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      result.push({ text: '', isBlank: true });
      continue;
    }
    let currentLine = '';
    for (const word of paragraph.split(' ')) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (measureText(ctx, candidate, letterSpacing) > maxWidth && currentLine) {
        result.push({ text: currentLine, isBlank: false });
        currentLine = word;
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine) result.push({ text: currentLine, isBlank: false });
  }
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeLayout(
  ctx: any,
  text: string,
  maxWidth: number,
  headerH: number,
  cfg: CanvasConfig
): { fontSize: number; lineHeight: number; lines: WrappedLine[]; padding: number } {
  const sizes: number[] = [];
  for (let s = cfg.maxFontSize; s > cfg.minFontSize; s -= cfg.fontSizeStep) sizes.push(s);
  sizes.push(cfg.minFontSize);

  for (let i = 0; i < sizes.length; i++) {
    const fontSize = sizes[i];
    ctx.font = `${FONT_WEIGHT} ${fontSize}px "Libre Franklin"`;
    const lineHeight = fontSize * cfg.lineHeightMult;
    const blankH = lineHeight * cfg.blankLineRatio;
    const lines = wrapTextToLines(ctx, text, maxWidth, cfg.letterSpacing);
    const totalTextH = lines.reduce((acc, l) => acc + (l.isBlank ? blankH : lineHeight), 0);
    const contentH = headerH + cfg.gap + totalTextH;
    // Center in full canvas height, but clamp so content bottom stays within contentAreaHeight
    const idealPadding = (H - contentH) / 2;
    const maxPadding = cfg.contentAreaHeight - contentH;
    const padding = Math.min(idealPadding, maxPadding);

    const isLast = i === sizes.length - 1;
    if (padding >= cfg.minTopPadding || isLast) {
      return { fontSize, lineHeight, lines, padding: Math.max(0, padding) };
    }
  }

  return { fontSize: cfg.minFontSize, lineHeight: cfg.minFontSize * cfg.lineHeightMult, lines: [], padding: 0 };
}

export async function renderTweetToBuffer(text: string, configOverride?: Partial<CanvasConfig>): Promise<Buffer> {
  const { createCanvas, loadImage } = await getCanvas();
  const cfg: CanvasConfig = { ...loadConfig(), ...configOverride };
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 1. Background
  ctx.fillStyle = cfg.bgColor;
  ctx.fillRect(0, 0, W, H);

  // 2. Load header image and compute its height
  const headerImage = await loadImage(path.join(process.cwd(), 'public/ig-pipeline/Header.png'));
  const ratio = headerImage.height / headerImage.width;
  const headerH = cfg.headerWidth * ratio;

  // 3. Compute layout
  const maxTextWidth = cfg.textRightBoundary - cfg.textPaddingX;
  const layout = computeLayout(ctx, text, maxTextWidth, headerH, cfg);

  // 4. Draw header (centered within active area, with topOffset cosmetic shift)
  const headerY = layout.padding - cfg.topOffset;
  ctx.drawImage(headerImage, cfg.headerX, headerY, cfg.headerWidth, headerH);

  // 5. Draw text
  const textY = headerY + headerH + cfg.gap;
  ctx.fillStyle = cfg.textColor;
  ctx.textBaseline = 'top';
  ctx.font = `${FONT_WEIGHT} ${layout.fontSize}px "Libre Franklin"`;

  let currentY = textY;
  for (const line of layout.lines) {
    if (line.isBlank) {
      currentY += layout.lineHeight * cfg.blankLineRatio;
    } else {
      fillTextWithSpacing(ctx, line.text, cfg.textPaddingX, currentY, cfg.letterSpacing);
      currentY += layout.lineHeight;
    }
  }

  return canvas.toBuffer('image/png');
}

export type { CanvasConfig };
