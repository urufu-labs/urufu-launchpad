// toGatewayUrl sends every IPFS read through our /api/ipfs route, including
// old gateway links the indexer stored (nftstorage.link etc. died in 2026-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGatewayUrl } from './ipfsFetch.ts';

const CID = 'bafybeidpcettthsvgogrxmxsaceasbpyhhxq5p5esl6iflmi4ta6udg6ka';

test('ipfs:// goes through the route', () => {
  assert.equal(toGatewayUrl(`ipfs://${CID}/image-001.webp`), `/api/ipfs/${CID}/image-001.webp`);
  assert.equal(toGatewayUrl(`ipfs://ipfs/${CID}/1.json`), `/api/ipfs/${CID}/1.json`);
});

test('old gateway links are rewritten', () => {
  for (const host of ['nftstorage.link', 'w3s.link', 'ipfs.io', 'dweb.link', 'gateway.pinata.cloud', 'cloudflare-ipfs.com']) {
    assert.equal(toGatewayUrl(`https://${host}/ipfs/${CID}/image-001.webp`), `/api/ipfs/${CID}/image-001.webp`);
  }
});

test('other links pass through, junk returns null', () => {
  assert.equal(toGatewayUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(toGatewayUrl('data:image/png;base64,xx'), null);
  assert.equal(toGatewayUrl(''), null);
  assert.equal(toGatewayUrl(undefined), null);
});
