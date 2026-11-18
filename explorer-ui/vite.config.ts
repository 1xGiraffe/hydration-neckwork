import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Regex with a trailing slash, not the '/api' prefix: a bare prefix also captures
// PAGE routes that merely start with it — /api-tokens was proxied upstream as
// '-tokens' instead of being served as the SPA. Production nginx matches
// `location /api/` and never had the problem. Shared so the dev server and
// `vite preview` cannot drift apart.
const API_PROXY = {
  '^/api/': {
    target: 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
  // Forum images: nginx maps /ipfs/<cid> onto the api's /forum/media/<cid> (nginx.conf).
  '^/ipfs/': {
    target: 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/ipfs\//, '/forum/media/'),
  },
}

// route-chunks.json: for each lazily loaded page (src/pages/<Name>.tsx), the chunks
// and stylesheets its first render needs beyond what index.html already loads. The
// api's head renderer (api/src/routes/seo.ts) reads it beside the shell and names
// them in a page's <head> as modulepreload/preload links, so a cold load fetches the
// route's code alongside the entry instead of after it. `entry` ties the file to the
// index.html it was built with; the renderer ignores a file that names another.
const routeChunksManifest = {
  name: 'route-chunks-manifest',
  apply: 'build' as const,
  generateBundle(_options: unknown, bundle: Record<string, { type: string; fileName: string; isEntry?: boolean; isDynamicEntry?: boolean; facadeModuleId?: string | null; imports?: string[]; viteMetadata?: { importedCss?: Set<string> } }>) {
    const chunks = Object.values(bundle).filter(c => c.type === 'chunk')
    const byFile = new Map(chunks.map(c => [c.fileName, c]))
    const closure = (file: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(file)) return seen
      seen.add(file)
      for (const i of byFile.get(file)?.imports ?? []) closure(i, seen)
      return seen
    }
    const entry = chunks.find(c => c.isEntry && /\/index\.html$|src\/main\.tsx$/.test(c.facadeModuleId ?? ''))
    if (!entry) return
    const eager = closure(entry.fileName)
    const pages: Record<string, string[]> = {}
    for (const c of chunks) {
      const m = c.isDynamicEntry ? /\/src\/pages\/([A-Za-z0-9]+)\.tsx$/.exec(c.facadeModuleId ?? '') : null
      if (!m) continue
      const files = [...closure(c.fileName)].filter(f => !eager.has(f))
      const css = files.flatMap(f => [...(byFile.get(f)?.viteMetadata?.importedCss ?? [])])
      pages[m[1]] = [...files, ...new Set(css)]
    }
    ;(this as unknown as { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void })
      .emitFile({ type: 'asset', fileName: 'route-chunks.json', source: JSON.stringify({ entry: entry.fileName, pages }) })
  },
}

export default defineConfig({
  plugins: [react(), routeChunksManifest, {
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
          // The forum renderer (markdown-it and DOMPurify) loads with the governance
          // pages that show forum text, never with the landing page.
          if (/\/node_modules\/(markdown-it|dompurify|linkify-it|mdurl|uc\.micro|punycode\.js|entities|@types\/trusted-types)\//.test(id)) return 'markdown'
          // Only the runtime every route needs is pinned to the eager vendor chunk.
          // Every other package (the Radix dialog stack, the QR encoder and decoder,
          // the hashing and codec libraries dedot and viem share) is left to the
          // bundler, so it follows its lazy importers instead of riding on every route.
          if (/\/node_modules\/(react|react-dom|scheduler|@tanstack\/query-core|@tanstack\/react-query)\//.test(id)) return 'vendor'
          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      ...API_PROXY,
    },
  },
  // Keep preview behavior aligned with the development server.
  preview: {
    port: 5175,
    proxy: {
      ...API_PROXY,
    },
  },
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
