import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  // Relative asset URLs so `dist/` works when served from any path,
  // e.g. `cd dist && python3 -m http.server`.
  base: './',
  server: { port: 5173, open: false },
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
