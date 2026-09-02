/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  /**
   * Stamped into the bundle so every till can show which build it is running.
   *
   * Two tills on the same URL can genuinely be on different builds — a service worker
   * serves the old one until every window closes — so "are you on the new version?"
   * has to be answerable by looking, not by inferring it from behaviour.
   */
  define: {
    __APP_BUILD__: JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt', // never silently reload a POS mid-transaction — the
                               // cashier accepts the update banner when idle
      injectRegister: null,   // registered manually in src/main.tsx so we control
                               // the update-prompt/offline-ready UI
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Ticket POS',
        short_name: 'Ticket POS',
        description: 'Danbaiwa Restaurant ticketing & shift POS',
        start_url: '/',
        display: 'standalone',
        background_color: '#f8fafc',
        theme_color: '#f59e0b',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512x512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Pre-cache EVERYTHING at service worker install time.
        // After the first online visit these files are available forever offline.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        navigateFallback: '/index.html',
        // Never let the service worker expire the pre-cached shell
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Supabase calls are NEVER cached — the outbox pattern in
            // useSyncStore.ts owns all retry/backoff for offline mutations.
            urlPattern: ({ url }) => url.hostname.endsWith('.supabase.co'),
            handler: 'NetworkOnly',
          },
          {
            // App shell HTML — try network first, fall back to cache.
            // networkTimeoutSeconds ensures a slow connection doesn't block boot.
            urlPattern: ({ request }) => request.destination === 'document',
            handler: 'NetworkFirst',
            options: { cacheName: 'html-shell', networkTimeoutSeconds: 3 },
          },
          {
            // JS/CSS/fonts — serve from cache instantly, revalidate in background.
            // This means the app opens at full speed even with a slow connection.
            urlPattern: ({ request }) =>
              ['script', 'style', 'font'].includes(request.destination),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'static-assets' },
          },
        ],
      },
      devOptions: { enabled: false }, // test via `npm run build && npm run preview`
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/tests/setup/fakeIndexedDb.ts'],
  },
});
