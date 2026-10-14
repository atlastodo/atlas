import { quickAddLexicons, type QuickAddLexicon } from "./quickAddLexicons";

/**
 * The quick-add lexicons as plain JSON, for the Rust client (`crates/atlas-client`), which reads
 * them from `crates/atlas-client/src/rules/quick_add_lexicons.json`. Phrase maps become lists of
 * `[phrase, value]` pairs so their order (which breaks ties between equally long matches) survives.
 * `quickAddLexiconsWire.test.ts` fails when that file is stale; regenerate it with
 * `bun packages/shared/scripts/export-quick-add-lexicons.ts`.
 */

export const QUICK_ADD_LANGUAGES = ["en", "da", "de", "es", "fr", "it", "nl", "pl", "pt"] as const;

type Wire = Record<string, unknown>;

function toWire(lex: QuickAddLexicon): Wire {
  const out: Wire = {};
  for (const [key, value] of Object.entries(lex)) {
    out[key] =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.entries(value)
        : value;
  }
  return out;
}

export function quickAddLexiconsWire(): Record<string, Wire> {
  return Object.fromEntries(
    QUICK_ADD_LANGUAGES.map((code) => [code, toWire(quickAddLexicons(code)[0]!)]),
  );
}
