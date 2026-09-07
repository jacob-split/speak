import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8787'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        app: path.resolve(__dirname, 'index.html'),
        calltoolsGateway: path.resolve(__dirname, 'calltools-gateway.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/speak/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/speak\/api/, '/api'),
        ws: true,
      },
      '/speak/.well-known': {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/speak\/\.well-known/, '/.well-known'),
      },
      '/speak/mcp': {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/speak\/mcp/, '/mcp'),
      },
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
