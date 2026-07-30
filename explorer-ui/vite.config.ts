import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // History (clean-path) routing: built asset URLs must be absolute (`/assets/…`)
  // so they resolve on deep paths like `/account/x`. `base: '/'` is Vite's default
  // but we pin it so it never drifts. `appType: 'spa'` (also the default) makes
  // both `vite` dev and `vite preview` serve index.html for unknown paths
  // (SPA fallback), so a hard load of `/activity`, `/account/x`, etc. boots the app.
  base: '/',
  appType: 'spa',
  build: {
    rollupOptions: {
      output: {
        // React, react-dom, scheduler and React Query change only when a
        // dependency is upgraded, while the entry chunk changes on every deploy.
        // Sharing one hash made a returning reader re-download the runtime for an
        // app-only edit; a separate vendor chunk keeps it in the HTTP cache
        // (content-hashed `/assets/` is served with `expires max`, see nginx.conf).
        manualChunks: (id) => (id.includes('/node_modules/') ? 'vendor' : undefined),
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  // Keep preview behavior aligned with the development server.
  preview: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
