// Guard: the web app must never ship a keyed RPC provider URL to browsers.
// 2026-10-02: an Alchemy key set as a NEXT_PUBLIC_*_RPC_URL in Vercel was baked
// into the JS bundle, scraped, and ran up a ~$800 bill (account suspended).
// Browser code uses chain-default public RPCs only.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(f) && !f.endsWith('.test.mjs')) files.push(p);
  }
})(SRC);

test('no source reads a NEXT_PUBLIC_*RPC* env var', () => {
  const hits = files.filter((p) => /process\.env\.NEXT_PUBLIC_[A-Z_]*RPC/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits.map((h) => h.slice(SRC.length)), []);
});

test('no source hard-codes a keyed provider URL', () => {
  const keyed = /(g\.alchemy\.com\/v2\/|infura\.io\/v3\/|quiknode\.pro\/)/;
  const hits = files.filter((p) => keyed.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits.map((h) => h.slice(SRC.length)), []);
});
