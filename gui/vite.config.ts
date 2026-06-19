import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { resolve } from 'node:path'

// Tauri 在开发模式下调用 vite dev，生产模式调用 vite build。
// 端口固定为 1420（Tauri 默认），envPrefix 必须包含 TAURI_*，
// 这样 Rust 端的 env!() 宏才能读取前端环境变量。
export default defineConfig(async () => ({
  plugins: [react(), tailwind()],

  // Tauri 在 Windows 上构建时，如果 vite 频繁清屏会丢失 Rust 编译输出。
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 1421,
    },
    watch: {
      // 监听 src-tauri 时让 Tauri 自己处理重编译。
      ignored: ['**/tauri/**'],
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: ['es2022', 'chrome105', 'safari13'],
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: 'dist',
    emptyOutDir: true,
  },

  resolve: {
    alias: {
      '@': resolve(__dirname),
      '@shared': resolve(__dirname, 'shared'),
    },
  },

  // 不打包 Tauri API 包装器；它在 Rust 端通过 invoke 调用。
  // (无需显式 external — Tauri 2 把 invoke 注入 window.__TAURI__。)
}))