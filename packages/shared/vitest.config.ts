import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The sibling package from its sources, as tsconfig's `@atlastodo/source` condition sees it: its
// package.json `exports` otherwise point at a dist/ that only a pack builds.
const source = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@atlastodo\/client-core$/, replacement: source("client-core") }],
  },
});
