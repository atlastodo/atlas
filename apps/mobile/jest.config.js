/**
 * Jest for the RN app (`client-core` and `shared` use vitest): React Native ships a jest preset and
 * RN libraries' mocks assume it. This harness is only for what must render. Tests are behavioural
 * (query by role, text or label) and prefer dependency injection to module mocks.
 */
const path = require("path");
const expoPreset = require("jest-expo/jest-preset");

/**
 * jest-expo's preset, spread rather than named as `preset`: jest prepends a preset's setupFiles to
 * ours, and React Native's must run through `jest-rn-setup.js` instead. The merges jest would do for
 * a preset are done by hand below: our `transform` and `moduleNameMapper` entries first, then the
 * preset's.
 */
// The first is React Native's setup, which `jest-rn-setup.js` runs.
const expoSetupFiles = expoPreset.setupFiles.slice(1);

/** @type {import('jest').Config} */
module.exports = {
  ...expoPreset,
  resolver: "<rootDir>/jest-resolver.js",
  // Several suites run the real password KDF, which outlasts jest's 5 s default on a shared runner.
  testTimeout: 30_000,
  // React Native's setup goes through `jest-rn-setup.js` (the jsdom suites' `window`); then
  // jest-expo's. gesture-handler's double must load before the module graph (setupFiles);
  // reanimated's needs a live `expect` (setupFilesAfterEnv).
  setupFiles: [
    "<rootDir>/jest-rn-setup.js",
    ...expoSetupFiles,
    "<rootDir>/node_modules/react-native-gesture-handler/jestSetup.js",
  ],
  setupFilesAfterEnv: ["<rootDir>/jest-setup.ts"],
  // Without a roots pin jest walks the workspace root's `.bun` store and runs dependencies' tests.
  roots: ["<rootDir>/app", "<rootDir>/src"],
  // Bun's isolated linker puts packages at `node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>`, so
  // jest-expo's stock allowlist (anchored to the first `node_modules/`) transforms nothing. The
  // untranspiled ESM/Flow packages (react-native, expo-*, nativewind, ...) all live there.
  transformIgnorePatterns: [
    "node_modules/.bun/.*/node_modules/(?!(.*(react-native|expo|@expo|@noble|@scure|@react-navigation)))",
  ],
  transform: {
    // jest-expo's transform misses `.mjs`, which lucide's per-icon deep imports resolve to.
    "\\.mjs$": ["babel-jest", { presets: ["babel-preset-expo"] }],
    ...expoPreset.transform,
  },
  moduleNameMapper: {
    // The workspace packages are raw TS source, as Metro and tsc see them.
    "^@atlas/shared$": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    "^@atlas/client-core$": path.resolve(__dirname, "../../packages/client-core/src/index.ts"),
    // Babel injects `@babel/runtime` helpers relative to the file, and `packages/shared/` cannot
    // reach the app's copy under the isolated linker.
    "^@babel/runtime/(.*)$": path.resolve(__dirname, "node_modules/@babel/runtime/$1"),
    ...expoPreset.moduleNameMapper,
  },
};
