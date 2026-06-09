/**
 * Postpack hook — restores the full package.json that `prepack.mjs`
 * swapped out. Runs unconditionally so a failed pack still leaves the
 * working tree clean.
 */
import { renameSync, existsSync, unlinkSync } from 'node:fs';

const PKG = 'package.json';
const BAK = 'package.json.bak';

if (!existsSync(BAK)) {
  console.warn('[postpack] no package.json.bak found — nothing to restore');
  process.exit(0);
}

// Replace the pruned package.json with the original.
try {
  unlinkSync(PKG);
} catch {}
renameSync(BAK, PKG);
console.log('[postpack] restored full package.json');
