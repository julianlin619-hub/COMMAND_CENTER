/**
 * Text normalization for tweets before rendering onto canvas images.
 *
 * Cleans up raw tweet text by removing URLs, fixing spacing issues, and
 * trimming whitespace. This ensures the rendered image looks clean —
 * no random t.co links or double spaces in the middle of sentences.
 */

export function normalizeTweetText(raw: string): string {
  let text = raw;
  text = text.replace(/https?:\/\/\S+/g, '');           // remove URLs
  text = text.replace(/([.:]) {2,}([A-Z])/g, '$1 $2'); // collapse 2+ spaces → 1
  text = text.replace(/([.:])([A-Z])/g, '$1 $2');       // insert missing space
  text = text.replace(/ {2,}/g, ' ');                    // collapse leftover double spaces
  text = text.trim();
  return text;
}
