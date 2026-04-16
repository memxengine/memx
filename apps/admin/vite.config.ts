import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';

const API_URL = process.env.API_URL ?? 'http://localhost:3031';

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  server: {
    port: 3030,
    proxy: {
      // Proxy /api → engine so the admin can send cookies without CORS ceremony
      // during dev. In prod the admin sits behind the same base domain as the
      // engine so no proxy is needed.
      '/api': {
        target: API_URL,
        changeOrigin: true,
        cookieDomainRewrite: 'localhost',
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
