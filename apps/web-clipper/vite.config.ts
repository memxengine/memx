import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: 'popup.html',
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name.includes('extractor')) return 'content/extractor.js'
          return 'assets/[name]-[hash].js'
        },
      },
    },
  },
  plugins: [
    crx({ manifest }),
  ],
})
