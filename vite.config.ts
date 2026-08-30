/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
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
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            // The outbox pattern (src/store/useSyncStore.ts) already owns retry/backoff
            // for Supabase calls — the service worker must never cache or intercept them.
            urlPattern: ({ url }) => url.hostname.endsWith('.supabase.co'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ request }) => request.destination === 'document',
            handler: 'NetworkFirst',
            options: { cacheName: 'html-shell', networkTimeoutSeconds: 3 },
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
