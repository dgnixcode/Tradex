import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'scripts/__fixtures__/**',
      'research/**',
      'plan/**',
      // The web SPA has its own toolchain (Vite, browser globals, JSX). It is
      // deliberately outside the root Node composite build and the root lint,
      // which target server ESM with @types/node — a React/DOM config here would
      // add plugins and a parser surface that risk the green backend gate. The
      // app carries its own tsconfig + scripts; its money-critical invariant
      // ("no submit path from the ticket") is proven by a source-scan check that
      // DOES stay in the gate: checks/04-no-submit-path.check.mjs.
      'apps/web/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Money paths must never coerce. The CI rules script enforces the rest.
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Use the Money/Qty decimal layer.' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Node globals for the plain-ESM tooling scripts. The .ts packages get
    // these from @types/node, and typescript-eslint turns no-undef off there.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
        // fetch is a Node global since v18; the HTTP checks drive the server with it.
        fetch: 'readonly',
      },
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.mjs', 'scripts/**/*.mjs', 'checks/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
