import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real build identifier, not a hand-maintained version string: commit count as an
// incrementing build number (same convention as Android's versionCode) + the short hash for
// precision. Falls back honestly if git isn't available (e.g. a tarball build with no .git) —
// never fakes a number.
function getBuildInfo() {
  try {
    const buildNumber = execSync('git rev-list --count HEAD', { cwd: __dirname }).toString().trim()
    const commitHash = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()
    return { buildNumber, commitHash }
  } catch {
    return { buildNumber: 'unknown', commitHash: 'unknown' }
  }
}
const { buildNumber, commitHash } = getBuildInfo()

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_NUMBER__: JSON.stringify(buildNumber),
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  // Served as a GitHub Pages project site at deep21star.github.io/nutryos/,
  // not the domain root — every asset/manifest path needs this prefix or
  // the built JS/CSS 404s in production.
  base: '/nutryos/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'NUTRYOS',
        short_name: 'NUTRYOS',
        description: 'Snap a photo. NUTRYOS reads your meal and fills the ring instantly.',
        theme_color: '#0A0A0F',
        background_color: '#0A0A0F',
        display: 'standalone',
        start_url: '/nutryos/',
        scope: '/nutryos/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Long-press the home-screen icon → these show up as quick actions. The real web-app
        // equivalent of a native widget shortcut — there's no way to ship an actual live widget
        // from a browser-based PWA, this is the honest ceiling of what's possible here.
        shortcuts: [
          {
            name: 'Log a meal',
            short_name: 'Log meal',
            description: 'Jump straight into the camera to log a meal',
            url: '/nutryos/?action=log-meal',
            icons: [{ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
      workbox: {
        // Meal photos/API responses are handled by our own IndexedDB offline
        // queue (lib/offlineQueue.ts), not the service worker cache — this
        // only precaches the app shell so it launches offline.
        globPatterns: ['**/*.{js,css,html,svg}'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
} as any)
