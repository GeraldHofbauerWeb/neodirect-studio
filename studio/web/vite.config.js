import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The front end is the only part of this repository with a build step, and it is fenced into this
 * directory on purpose: the tools, the mod and the studio's own core stay dependency-free, so the
 * pipeline still runs on a machine that has never seen npm.
 */
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    // In development the browser talks to Vite and Vite talks to the studio, so there is one
    // origin and no CORS to arrange.
    proxy: { '/api': { target: 'http://127.0.0.1:8778', changeOrigin: true } },
  },
});
