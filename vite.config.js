import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: Vite on http://localhost:5173 proxies to the Novi HTTPS server.
// Phone use: `npm start` builds the UI and serves it from https://<lan-ip>:3001.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'https://localhost:3001', changeOrigin: true, secure: false },
      '/ws': { target: 'wss://localhost:3001', ws: true, secure: false }
    }
  },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node'
  }
})
