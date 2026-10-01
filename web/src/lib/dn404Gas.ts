/// DN404 per-transaction NFT gas guards.
///
/// Robinhood chain caps every transaction at 32,000,000 gas (ArbGasInfo
/// `getGasAccountingParams().maxTxGasLimit`, read 2026-10-01). Each mirror NFT
/// a DN404 transfer mints or burns costs roughly 11.5k gas, so one transaction
/// can move at most ~2,700 NFTs before it runs out of gas and reverts. These
/// pure helpers let the UI refuse a buy or sell that would cross more than
/// MAX_NFTS_PER_TX whole units, with headroom for the curve / pool / graduation
/// gas around the mints.

/// Max NFTs one buy or sell may mint or burn. ~2,700 is the hard ceiling; 2,000
/// leaves room for the rest of the transaction (curve math, pool swap, hook,
/// a possible graduation).
export const MAX_NFTS_PER_TX = 2000n;

/// Max NFTs per DN404 collection allowed on the create form. Bigger collections
/// mean smaller units, so ordinary-size buys cross more NFTs.
export const MAX_DN404_COLLECTION_SIZE = 10_000n;

/// NFTs minted when a wallet's token balance goes from `balanceBefore` up by
/// `tokensIn` (all values in wei). `unitWei` is tokens-per-NFT in wei.
/// Wallets with skipNFT set never mint NFTs; a zero unit is treated as "no NFTs".
export function nftsMinted(balanceBefore: bigint, tokensIn: bigint, unitWei: bigint, skipNft: boolean): bigint {
  if (skipNft || unitWei <= 0n || tokensIn <= 0n) return 0n;
  const before = balanceBefore < 0n ? 0n : balanceBefore;
  return (before + tokensIn) / unitWei - before / unitWei;
}

/// NFTs burned when a wallet's token balance goes down by `tokensOut`.
/// Clamps to the balance (you can't sell more than you hold).
export function nftsBurned(balanceBefore: bigint, tokensOut: bigint, unitWei: bigint, skipNft: boolean): bigint {
  if (skipNft || unitWei <= 0n || tokensOut <= 0n || balanceBefore <= 0n) return 0n;
  const out = tokensOut > balanceBefore ? balanceBefore : tokensOut;
  return balanceBefore / unitWei - (balanceBefore - out) / unitWei;
}

/// Largest token amount a single buy may deliver to this wallet while minting at
/// most `maxNfts` NFTs. Returns null when there is no limit (skipNFT, zero unit).
/// The result lands just below the (maxNfts + 1)-th unit boundary.
export function maxTokensInForNfts(
  balanceBefore: bigint,
  unitWei: bigint,
  skipNft: boolean,
  maxNfts: bigint = MAX_NFTS_PER_TX,
): bigint | null {
  if (skipNft || unitWei <= 0n) return null;
  const before = balanceBefore < 0n ? 0n : balanceBefore;
  const nextBoundaryAfterCap = (before / unitWei + maxNfts + 1n) * unitWei;
  return nextBoundaryAfterCap - 1n - before;
}

/// Largest token amount a single sell may take from this wallet while burning at
/// most `maxNfts` NFTs. Null when there is no limit.
export function maxTokensOutForNfts(
  balanceBefore: bigint,
  unitWei: bigint,
  skipNft: boolean,
  maxNfts: bigint = MAX_NFTS_PER_TX,
): bigint | null {
  if (skipNft || unitWei <= 0n) return null;
  if (balanceBefore <= 0n) return 0n;
  const held = balanceBefore / unitWei;
  if (held <= maxNfts) return balanceBefore;
  // Keep at least (held - maxNfts) whole units after the sell.
  return balanceBefore - (held - maxNfts) * unitWei;
}

/// Linear scale of an input amount to hit a target output, from one quote
/// (inputIn -> outputQuoted). Used only for an "about" hint: curve and pool
/// pricing is not linear, so this is approximate by design. Rounds down.
export function scaleInputForOutput(inputIn: bigint, outputQuoted: bigint, targetOutput: bigint): bigint {
  if (inputIn <= 0n || outputQuoted <= 0n || targetOutput <= 0n) return 0n;
  return (inputIn * targetOutput) / outputQuoted;
}
