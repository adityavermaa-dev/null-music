import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/saavn': {
        target: 'https://saavn.sumit.co',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/saavn/, '/api'),
        secure: false,
      },
      '/api/yt': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  }
})
