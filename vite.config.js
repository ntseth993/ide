import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base './' is required: the packaged app loads dist/index.html through the
// app:// protocol, so asset URLs must be relative.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 4500,
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    environmentMatchGlobs: [['**/*.test.jsx', 'jsdom']],
    include: ['tests/**/*.test.{js,jsx}'],
    css: false,
  },
});
