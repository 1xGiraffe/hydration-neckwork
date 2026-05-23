import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Some headless browsers (e.g. Obscura) silently skip external `type=module` script tags
// but execute inline `type=module` scripts. Rewrite the entry script tag to a dynamic
// import so the bundle still loads under those tools without affecting real browsers.
function inlineModuleEntry(): Plugin {
  return {
    name: 'inline-module-entry',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        /<script\s+([^>]*?)src="([^"]+\.js)"([^>]*)><\/script>/g,
        (_match, _pre, src) => `<script type="module">import(${JSON.stringify(src)});</script>`
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), inlineModuleEntry()],
  build: { modulePreload: { polyfill: false } },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
