import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web SPA's own build, independent of the root Node composite. In dev the
// planning API is proxied so the browser talks to same-origin /api and the app
// never needs a CORS story or a hardcoded host.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
  },
});
