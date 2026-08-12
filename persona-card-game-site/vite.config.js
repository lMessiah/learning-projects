import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  // Relative asset URLs so `dist/` works when served from any path,
  // e.g. `cd dist && python3 -m http.server`.
  base: './',
  server: {
    port: 5173,
    open: false,
    // In development the page is served from :5173 and the relay from :8788, so
    // the default relay address (same host, /ws) would point at Vite itself.
    // Proxying /ws makes the deployed layout and the dev layout identical, which
    // is what lets match links work locally with no settings change.
    proxy: {
      '/ws': { target: 'http://localhost:8788', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // The botMatch files play whole matches through a real jsdom board and are
    // by far the heaviest thing here (see tests/support/fullMatch.js). Left to
    // itself vitest opens one worker per core, and on a modest machine a worker
    // gets OOM-killed mid-run — which surfaces as "Worker exited unexpectedly"
    // and a SILENTLY SKIPPED file rather than a failure. Capping the pool keeps
    // the peak inside a small box while staying comfortably parallel.
    maxWorkers: 2,
  },
});
