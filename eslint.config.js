import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // `.tmp/` は .gitignore 済みの作業用置き場(計測スクリプトなど)。lint の対象外。
  { ignores: ["dist", "node_modules", "coverage", ".tmp"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "test/**/*.ts"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The simulation core must stay pure and deterministic:
    // no three.js, no DOM, no wall-clock, no unseeded randomness.
    files: ["src/sim/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Use the seeded RNG from src/sim/rng.ts." },
        { object: "Date", property: "now", message: "Sim code must not read the wall clock." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "requestAnimationFrame", message: "Sim core must not touch the render loop." },
        { name: "window", message: "Sim core must not touch the DOM." },
        { name: "document", message: "Sim core must not touch the DOM." },
      ],
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "three", message: "Sim core must not import three.js." }] },
      ],
    },
  },
  prettier,
);
