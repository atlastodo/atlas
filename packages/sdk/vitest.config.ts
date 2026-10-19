import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The sibling packages from their sources, as tsconfig's `@atlastodo/source` condition sees them:
// their package.json `exports` otherwise point at a dist/ that only a pack builds.
const source = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@atlastodo\/client-core$/, replacement: source("client-core") },
      { find: /^@atlastodo\/shared$/, replacement: source("shared") },
    ],
  },
});
