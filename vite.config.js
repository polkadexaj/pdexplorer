import { defineConfig } from 'vite';

const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:3001';

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      // Dev parity with production nginx: the backend serves sitemap.xml and
      // robots.txt so previewing SEO output locally hits the same code path.
      '/sitemap.xml': { target: apiTarget, changeOrigin: true },
      '/robots.txt': { target: apiTarget, changeOrigin: true }
    }
  },
  build: {
    target: 'esnext'
  }
});
