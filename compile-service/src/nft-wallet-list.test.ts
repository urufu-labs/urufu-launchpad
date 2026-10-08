import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Address } from 'viem';
import { buildWalletList, normalizeWallets, rootFromProof } from './nft-wallet-list.ts';

const W = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

// Same wallets + root are asserted in web/src/lib/nftWalletList.test.mjs and
// on-chain in contracts/test/nft/NftWalletListFork.t.sol.
export const GOLDEN_WALLETS: Address[] = [
  '0x6d606cc634f20f5534fba072757f2c2c7b835bb9',
  '0x61d0cfb665179f24fff054e4e5d0a9435fb4416e',
  '0x142f9398c909b1566dc0b7ae509bcfd4edfd10e7',
].map((a) => getAddress(a));

test('every member proves into the root, for sizes 1..33', () => {
  for (let n = 1; n <= 33; n++) {
    const ws = Array.from({ length: n }, (_, i) => W(i + 1));
    const t = buildWalletList(ws);
    for (const w of ws) {
      const proof = t.proofFor(w);
      assert.ok(proof, `missing proof n=${n}`);
      assert.equal(rootFromProof(w, proof!), t.root, `bad proof n=${n}`);
    }
    assert.equal(t.proofFor(W(9999)), null);
  }
});

test('order, case and duplicates do not change the root', () => {
  const a = buildWalletList(normalizeWallets(GOLDEN_WALLETS.join('\n'))).root;
  const b = buildWalletList(
    normalizeWallets([...GOLDEN_WALLETS].reverse().map((w) => w.toLowerCase()).concat(GOLDEN_WALLETS[0]!, 'junk', '')),
  ).root;
  assert.equal(a, b);
});

test('parses pasted lists with commas, spaces and junk', () => {
  const ws = normalizeWallets(`${GOLDEN_WALLETS[0]}, ${GOLDEN_WALLETS[1]}\n\nnot-an-address ${GOLDEN_WALLETS[2]};`);
  assert.equal(ws.length, 3);
});

test('golden root', () => {
  const root = buildWalletList(GOLDEN_WALLETS).root;
  console.log('GOLDEN_ROOT', root);
  assert.equal(root, '0x5669480fe09d7355743bbc2eda7ef9e612d273e656749685d6a4eb7536381a3e');
});
