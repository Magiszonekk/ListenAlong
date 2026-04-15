import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/auth': 'http://localhost:3005',
      '/spotify': 'http://localhost:3005',
      '/youtube': 'http://localhost:3005',
      '/log': 'http://localhost:3005',
      '/callback': 'http://localhost:3005',
      '/ws': { target: 'ws://localhost:3005', ws: true, rewriteWsOrigin: true },
    },
  },
})
