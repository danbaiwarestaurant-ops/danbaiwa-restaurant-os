/**
 * copy-print-agent.mjs
 *
 * Copies the print agent and its installer into public/, so the app can hand them to
 * whoever is setting up a till as ordinary download links.
 *
 * The alternative was telling a non-technical person to obtain two files from a git
 * repository, which is where every till setup was going to stall. They are copied rather
 * than kept in public/ directly so there is exactly one canonical version of each: the
 * one at the repository root, which is also the one `npm run print-server` runs.
 *
 * Wired to predev and prebuild, so a stale copy cannot be shipped.
 */

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'print-agent');

const FILES = ['print-server.cjs', 'install-print-agent.bat'];

mkdirSync(outDir, { recursive: true });

for (const name of FILES) {
  const from = join(root, name);
  if (!existsSync(from)) {
    console.error(`[copy-print-agent] missing ${name} at the repository root`);
    process.exit(1);
  }
  copyFileSync(from, join(outDir, name));
}

console.log(`[copy-print-agent] ${FILES.length} file(s) -> public/print-agent/`);
