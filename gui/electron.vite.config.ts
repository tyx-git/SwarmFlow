import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/index.ts'),
      },
      rollupOptions: {
        external: ['electron'],
      },
      outDir: 'out/main',
    },
  },
  preload: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/preload.ts'),
      },
      rollupOptions: {
        external: ['electron'],
      },
      outDir: 'out/preload',
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react(), tailwind()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared'),
      },
    },
    build: {
      outDir: '../out/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html'),
        },
      },
    },
    server: {
      port: 5174,
      strictPort: true,
    },
  },
})
