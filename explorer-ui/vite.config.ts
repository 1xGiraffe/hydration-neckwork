import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    // The authored index.html carries engineering rationale (favicon fallback,
    // font-preload CLS math) that documents the file for the repo — but none of
    // it belongs in the HTML every visitor downloads. Strip comments from the
    // BUILD output only; dev keeps them so view-source matches the source file.
    name: 'strip-html-comments',
    apply: 'build' as const,
    transformIndexHtml: (html: string) => html.replace(/[ \t]*<!--[\s\S]*?-->\n?/g, ''),
  }],
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
        // viem (+ its codec deps) is imported only by the lazily-loaded
        // src/abiCodec.ts; its own chunk keeps the ABI codec out of the eager
        // vendor download and loads it with the contract tab instead. dedot
        // follows the same rule via src/substrateWrite.ts: it loads only when
        // a Substrate wallet connects on the contract Write tab.
        manualChunks: (id) => {
          if (/\/node_modules\/(viem|abitype|ox)\//.test(id)) return 'abi-codec'
          if (/\/node_modules\/(dedot|@dedot|smoldot)\//.test(id)) return 'dedot'
          return id.includes('/node_modules/') ? 'vendor' : undefined
        },
      },
    },
  },
  server: {
    proxy: {
      // Regex with a trailing slash, not the '/api' prefix: a bare prefix also
      // captures PAGE routes that merely start with it — /api-tokens was
      // proxied upstream as '-tokens' instead of being served as the SPA.
      // Production nginx matches `location /api/` and never had the problem.
      '^/api/': {
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
      // Regex with a trailing slash, not the '/api' prefix: a bare prefix also
      // captures PAGE routes that merely start with it — /api-tokens was
      // proxied upstream as '-tokens' instead of being served as the SPA.
      // Production nginx matches `location /api/` and never had the problem.
      '^/api/': {
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
