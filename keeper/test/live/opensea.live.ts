/**
 * Read-only live check of the production OpenSea provider against the real
 * API (key from repo-root .env OPENSEA_API_KEY, sent only to api.opensea.io).
 * Proves the request shapes resolve on chain `robinhood`: slug lookup for the
 * $SMOKE mirror and a best-listings call. Empty listings are fine; no
 * fulfillment is requested (that would need a real listing).
 * Run: npm run test:live-opensea
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { OpenSeaProvider } from '../../src/opensea.ts';
import { repoEnv } from '../fork/harness.ts';

const SMOKE_MIRROR = '0x375f4d9ce84607dbe0fce6b55b1c5b9335b87ba3' as const;

test('OpenSea provider resolves the $SMOKE collection and fetches best listings on robinhood', async () => {
  const p = new OpenSeaProvider(repoEnv('OPENSEA_API_KEY'), 'robinhood', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
  const slug = await p.slugFor(SMOKE_MIRROR);
  assert.equal(slug, 'dn404-smoke');
  const listings = await p.bestListings(SMOKE_MIRROR, 20);
  assert.ok(Array.isArray(listings));
  console.log(`slug=${slug} listings=${listings.length}${listings.length ? ` cheapest=${listings[0]!.priceWei} wei #${listings[0]!.tokenId}` : ''}`);
});
