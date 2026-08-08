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
  },
});
