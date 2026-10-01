/// DN404 per-transaction NFT gas guard math.
///
/// Run:
///   node --experimental-strip-types --disable-warning=ExperimentalWarning \
///     --test src/lib/dn404Gas.test.mjs

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  MAX_DN404_COLLECTION_SIZE,
  MAX_NFTS_PER_TX,
  maxTokensInForNfts,
  maxTokensOutForNfts,
  nftsBurned,
  nftsMinted,
  scaleInputForOutput,
} from './dn404Gas.ts';

const E18 = 10n ** 18n;
const UNIT = 10_000n * E18; // 10,000 tokens per NFT

describe('nftsMinted', () => {
  it('counts unit boundaries crossed from zero', () => {
    assert.equal(nftsMinted(0n, 186_331n * E18, UNIT, false), 18n);
  });
  it('counts boundaries from a partial starting balance', () => {
    // 9,999 -> 10,001 crosses exactly one boundary.
    assert.equal(nftsMinted(9_999n * E18, 2n * E18, UNIT, false), 1n);
  });
  it('exact multiples land on the boundary', () => {
    assert.equal(nftsMinted(0n, UNIT, UNIT, false), 1n);
    assert.equal(nftsMinted(UNIT, UNIT, UNIT, false), 1n);
    assert.equal(nftsMinted(0n, UNIT - 1n, UNIT, false), 0n);
  });
  it('skipNFT wallets mint nothing', () => {
    assert.equal(nftsMinted(0n, 100n * UNIT, UNIT, true), 0n);
  });
  it('zero unit and zero amount are guarded', () => {
    assert.equal(nftsMinted(0n, 100n * E18, 0n, false), 0n);
    assert.equal(nftsMinted(5n * UNIT, 0n, UNIT, false), 0n);
  });
});

describe('nftsBurned', () => {
  it('matches the live $UPT sell: 186,331 -> 93,166 tokens burns 9', () => {
    assert.equal(nftsBurned(186_331n * E18, 93_165n * E18, UNIT, false), 9n);
  });
  it('selling everything burns every NFT held', () => {
    assert.equal(nftsBurned(111_799n * E18, 111_799n * E18, UNIT, false), 11n);
  });
  it('clamps to the balance and respects skipNFT / zero unit', () => {
    assert.equal(nftsBurned(3n * UNIT, 10n * UNIT, UNIT, false), 3n);
    assert.equal(nftsBurned(3n * UNIT, UNIT, UNIT, true), 0n);
    assert.equal(nftsBurned(3n * UNIT, UNIT, 0n, false), 0n);
  });
});

describe('the 2,000 NFT cap', () => {
  it('constants', () => {
    assert.equal(MAX_NFTS_PER_TX, 2000n);
    assert.equal(MAX_DN404_COLLECTION_SIZE, 10_000n);
  });
  it('maxTokensInForNfts mints exactly the cap and one more token crosses it', () => {
    for (const before of [0n, 9_999n * E18, 5n * UNIT, 5n * UNIT + 1n]) {
      const max = maxTokensInForNfts(before, UNIT, false);
      assert.equal(nftsMinted(before, max, UNIT, false), MAX_NFTS_PER_TX, `at max, before=${before}`);
      assert.equal(nftsMinted(before, max + 1n, UNIT, false), MAX_NFTS_PER_TX + 1n, `one past, before=${before}`);
    }
  });
  it('maxTokensInForNfts is unlimited for skipNFT or zero unit', () => {
    assert.equal(maxTokensInForNfts(0n, UNIT, true), null);
    assert.equal(maxTokensInForNfts(0n, 0n, false), null);
  });
  it('maxTokensOutForNfts burns exactly the cap', () => {
    const before = 2_500n * UNIT + 7n;
    const max = maxTokensOutForNfts(before, UNIT, false);
    assert.equal(nftsBurned(before, max, UNIT, false), MAX_NFTS_PER_TX);
    assert.equal(nftsBurned(before, max + 1n, UNIT, false), MAX_NFTS_PER_TX + 1n);
  });
  it('maxTokensOutForNfts lets small holders sell everything', () => {
    assert.equal(maxTokensOutForNfts(1_500n * UNIT, UNIT, false), 1_500n * UNIT);
    assert.equal(maxTokensOutForNfts(0n, UNIT, false), 0n);
    assert.equal(maxTokensOutForNfts(5_000n * UNIT, UNIT, true), null);
  });
});

describe('scaleInputForOutput', () => {
  it('scales linearly and guards zeros', () => {
    assert.equal(scaleInputForOutput(1000n, 200n, 50n), 250n);
    assert.equal(scaleInputForOutput(0n, 200n, 50n), 0n);
    assert.equal(scaleInputForOutput(1000n, 0n, 50n), 0n);
  });
});
