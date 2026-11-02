import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Core has no app's rules: its tests register a todo-shaped test app (scope_rule_vectors.json).
    setupFiles: ["./src/testApp.testutil.ts"],
  },
});
