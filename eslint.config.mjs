// ESLint 9 and later read only this flat config. The file must end in .mjs: `.gitignore` ignores every *.js outside a few
// named places. TypeScript's own checker reports undefined names, so typescript-eslint's recommended set already turns
// `no-undef` off for .ts files.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "features/0[1-6]*/**", "**/*.js", "**/*.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The same two rules the old .eslintrc.json switched off (the second one is called no-var-requires there).
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
