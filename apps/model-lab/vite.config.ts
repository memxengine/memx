import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';

const API_URL = process.env.API_URL ?? 'http://localhost:3032';

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  root: 'src/ui',
  server: {
    port: 3033,
    proxy: {
      '/api': {
        target: API_URL,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../../dist',
    sourcemap: true,
  },
});
