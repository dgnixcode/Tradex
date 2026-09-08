import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // apps/web is a browser SPA with its own Vite/vitest toolchain; its tests need
    // jsdom, not this node environment, so the root run skips them. Everything the
    // web app must guarantee server-side is proven by the checks in the gate.
    exclude: ['**/node_modules/**', '**/dist/**', 'scripts/__fixtures__/**', 'apps/web/**'],
    environment: 'node',
  },
});
