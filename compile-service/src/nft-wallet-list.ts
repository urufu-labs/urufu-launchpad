/// Wallet lists for NFT whitelists and wallet-list discount tiers.
///
/// Matches the contracts byte for byte:
///   - leaf = keccak256(bytes.concat(keccak256(abi.encode(wallet))))
///     (NftWhitelistModule.isEligible, NftDiscountVerifier.verifyWalletList)
///   - pairs hashed in sorted order (solady MerkleProofLib.verify)
/// Leaves are sorted ascending and an odd node is carried up unchanged, so the
/// same set of wallets always gives the same root. The web never builds trees:
/// it posts lists here and asks for proofs (routes/nft-wl.ts). The golden root
/// in nft-wallet-list.test.ts and its proofs are checked on-chain in
/// contracts/test/nft/NftWalletListFork.t.sol.

import { concat, encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from 'viem';

export const MAX_WALLET_LIST_SIZE = 10_000;

export function walletLeaf(wallet: Address): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: 'address' }], [wallet])));
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/// Parse a pasted list (newlines, commas, spaces). Invalid entries are dropped,
/// duplicates collapse, output is checksummed and sorted by leaf.
export function normalizeWallets(input: string | string[]): Address[] {
  const parts = Array.isArray(input) ? input : input.split(/[\s,;]+/);
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s || !isAddress(s, { strict: false })) continue;
    const a = getAddress(s);
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export interface WalletListTree {
  root: Hex;
  wallets: Address[];
  proofFor(wallet: Address): Hex[] | null;
}

export function buildWalletList(wallets: Address[]): WalletListTree {
  if (wallets.length === 0) throw new Error('empty wallet list');
  const pairs = wallets.map((w) => ({ w, leaf: walletLeaf(w) }));
  pairs.sort((x, y) => (BigInt(x.leaf) < BigInt(y.leaf) ? -1 : BigInt(x.leaf) > BigInt(y.leaf) ? 1 : 0));
  const layers: Hex[][] = [pairs.map((p) => p.leaf)];
  while (layers[layers.length - 1]!.length > 1) {
    const cur = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? hashPair(cur[i]!, cur[i + 1]!) : cur[i]!);
    }
    layers.push(next);
  }
  const indexByWallet = new Map(pairs.map((p, i) => [p.w.toLowerCase(), i]));
  return {
    root: layers[layers.length - 1]![0]!,
    wallets: pairs.map((p) => p.w),
    proofFor(wallet: Address): Hex[] | null {
      let idx = indexByWallet.get(wallet.toLowerCase());
      if (idx === undefined) return null;
      const proof: Hex[] = [];
      for (let l = 0; l < layers.length - 1; l++) {
        const layer = layers[l]!;
        const sib = idx ^ 1;
        if (sib < layer.length) proof.push(layer[sib]!);
        idx = Math.floor(idx / 2);
      }
      return proof;
    },
  };
}

/// Recompute a root from a leaf and proof (same rule as solady verify).
export function rootFromProof(wallet: Address, proof: Hex[]): Hex {
  let h = walletLeaf(wallet);
  for (const p of proof) h = hashPair(h, p);
  return h;
}
