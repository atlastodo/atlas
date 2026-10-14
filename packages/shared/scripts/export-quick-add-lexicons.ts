// Writes the quick-add lexicons for the Rust client: bun packages/shared/scripts/export-quick-add-lexicons.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { quickAddLexiconsWire } from "../src/quickAddLexiconsWire";

const target = fileURLToPath(
  new URL("../../../crates/atlas-client/src/rules/quick_add_lexicons.json", import.meta.url),
);
writeFileSync(target, `${JSON.stringify(quickAddLexiconsWire(), null, 2)}\n`);
console.log(`wrote ${target}`);
