// Copy guard for the user-facing guide pages (docs + modules) and the DN404
// tax-mode text they render. The user asked for plain, non-technical,
// non-AI-sounding copy: no em/en dashes and none of the stock "AI" words.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const FILES = {
  docs: join(APP, 'docs', 'page.tsx'),
  modules: join(APP, 'catalog', 'page.tsx'),
};
const CONFIG = join(APP, '..', 'lib', 'config.ts');

const BANNED = /\b(seamless(ly)?|unlock(s|ed|ing)?|leverag(e|es|ed|ing)|dive in|robust|empower(s|ed|ing)?|journey|game-?changer|effortless(ly)?|cutting-edge|elevat(e|es|ed|ing))\b/i;

// Strip comments so developer notes don't count; we only police visible copy.
const visible = (src) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const taxModesBlock = () => {
  const src = readFileSync(CONFIG, 'utf8');
  const start = src.indexOf('export const DN404_TAX_MODES');
  return visible(src.slice(start, src.indexOf('];', start)));
};

for (const [name, path] of Object.entries(FILES)) {
  test(`${name} page has no em or en dashes in visible copy`, () => {
    const hits = visible(readFileSync(path, 'utf8')).match(/[—–]/g) ?? [];
    assert.equal(hits.length, 0, `found ${hits.length} dash(es) in ${name}`);
  });
  test(`${name} page avoids stock AI words`, () => {
    const m = visible(readFileSync(path, 'utf8')).match(BANNED);
    assert.equal(m, null, `banned word "${m?.[0]}" in ${name}`);
  });
}

test('DN404 tax-mode copy has no em dashes or stock AI words', () => {
  const block = taxModesBlock();
  assert.equal((block.match(/[—–]/g) ?? []).length, 0);
  assert.equal(block.match(BANNED), null);
});

test('docs page does not use developer jargon in visible copy', () => {
  const src = visible(readFileSync(FILES.docs, 'utf8'));
  for (const word of ['Merkle', 'configHash', 'codehash', 'abiEncode', ' bps', 'keeper']) {
    assert.ok(!src.includes(word), `jargon "${word}" in docs page`);
  }
});
