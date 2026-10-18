// ESLint for the TypeScript packages and apps. Formatting is Prettier's job (.prettierrc.json).
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.expo/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/android/**",
      "dist-desktop/**",
      "dist-packages/**",
      "dist-web/**",
      "target/**",
      ".claude/**",
      // The jest cache CI keeps inside the checkout.
      ".jest-cache/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The `_` prefix marks a deliberately unused binding, as it does for tsc's noUnused* checks.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["apps/mobile/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.object.name='Animated'] > JSXAttribute[name.name=/^(className|contentContainerClassName)$/]",
          message: "NativeWind does not style Reanimated components; use style or an inner View.",
        },
      ],
    },
  },
);
