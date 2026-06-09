import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    linterOptions: {
      reportUnusedDisableDirectives: "warn"
    },
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "**/apps/bandit-stealth/media/v2/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      curly: ["warn", "all"],
      eqeqeq: ["error", "smart"],
      "no-debugger": "error",
      "no-fallthrough": "error",
      "no-implicit-coercion": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn"
    }
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true
        }
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
          disallowTypeAnnotations: false
        }
      ],
      "@typescript-eslint/ban-ts-comment": [
        "warn",
        { "ts-ignore": "allow-with-description", minimumDescriptionLength: 3 }
      ]
    }
  },
  {
    files: ["**/*.{js,cjs,mjs}"],
    rules: {
      "no-unused-vars": [
        "warn",
        { args: "none", ignoreRestSiblings: true }
      ]
    }
  }
);
