import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The core packages from their sources, as tsconfig's `@atlastodo/source` condition sees them:
// their package.json `exports` otherwise point at a dist/ that only a pack builds.
const source = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@atlastodo\/client-core$/, replacement: source("client-core") },
      // A test may import this package by its own name.
      { find: /^@atlastodo\/shared$/, replacement: source("shared") },
    ],
  },
});
