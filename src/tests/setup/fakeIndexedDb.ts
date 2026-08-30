// Polyfills `indexedDB` in the Node test environment so Dexie-backed services
// (IndexedDbService) can run under Vitest without a browser.
import 'fake-indexeddb/auto';
