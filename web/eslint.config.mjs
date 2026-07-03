import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // React 19 compiler + hooks rules are aggressive: they flag idiomatic patterns
      // we intentionally use (mount-guards for SSR hydration, effect-driven subscriptions
      // for the trade event stream + drag listeners, and one-time-init refs on the launch
      // success path). None of these are correctness bugs. Turn off as errors.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/preserve-manual-memoization": "off",
      // Cosmetic — apostrophes in JSX text.
      "react/no-unescaped-entities": "off",
      // Allow intentionally-unused error bindings + narrowing throwaways.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_?err" },
      ],
    },
  },
]);

export default eslintConfig;
