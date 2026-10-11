import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'

let buildId = 'dev'
try { buildId = execSync('git rev-parse --short HEAD').toString().trim() } catch (e) { /* khong co git */ }

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss()
  ],
  define: {
    __BUILD__: JSON.stringify(buildId),
  },
  server: {
    host: true,  // Allow network access
    port: 5173,
    historyApiFallback: true,
    watch: {
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**']
    },
    hmr: {
      overlay: false
    },
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
