import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves a project repo from a sub-path
// (/orderko/), so the deploy workflow sets VITE_BASE. Local dev and
// any root-hosted deploy leave it unset and serve from '/'.
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
