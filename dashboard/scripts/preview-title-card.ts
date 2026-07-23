/**
 * Throwaway preview: renders the carousel title card to /tmp so the design
 * can be iterated on locally without the dashboard or the cron.
 *
 *   cd dashboard && npx tsx scripts/preview-title-card.ts
 */
import fs from "fs/promises";
import { renderSquareQuoteCard } from "../src/lib/square-canvas-render";
import { DEFAULT_INSTAGRAM_TEMPLATE_CONFIG } from "../src/lib/template-types";

async function main() {
  const png = await renderSquareQuoteCard(
    "Brutally honest advice to my younger self (Day 1)",
    DEFAULT_INSTAGRAM_TEMPLATE_CONFIG,
    { swipeBadge: true },
  );
  await fs.writeFile("/tmp/title-card.png", png);
  console.log("wrote /tmp/title-card.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
