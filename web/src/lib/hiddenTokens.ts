/// Central hide-list applied everywhere the UI enumerates tokens or trades.
///
/// These tokens still work at direct URLs (a friend can paste the address into
/// `/trade/<addr>` and see the page), but they don't appear in feed-style lists:
/// home marquee, discover, live-trade rail, profile grids, etc. Anything that
/// consumes indexer results (`fetchRecentLaunches`, `fetchRecentTrades`,
/// `fetchLaunchesByCreator`, etc.) filters through the helpers here.
///
/// Keyed by `${chainId}:${lowercaseAddress}` for O(1) lookup.
///
/// Current entries — pre-production test tokens that shouldn't be prominent:
///   - TEST on Base       (0xde1323b369b362bc1ad3d036bef964279e8eb1c7)
///   - BALLS on Base Sepolia (0x92462af2c2c8d2a18dcbbddd66c8aa401ec2de6d)

import type { Address } from 'viem';

export const HIDDEN_TOKENS: ReadonlySet<string> = new Set<string>([
  '8453:0xde1323b369b362bc1ad3d036bef964279e8eb1c7',
  '84532:0x92462af2c2c8d2a18dcbbddd66c8aa401ec2de6d',
]);

export function isHiddenToken(chainId: number, tokenAddress: Address | string): boolean {
  const addr = typeof tokenAddress === 'string' ? tokenAddress.toLowerCase() : (tokenAddress as string).toLowerCase();
  return HIDDEN_TOKENS.has(`${chainId}:${addr}`);
}

/// Curried filter for `.filter()` callbacks on rows that carry both fields.
export const notHidden = <T extends { chainId: number; tokenAddress: Address | string }>(row: T): boolean =>
  !isHiddenToken(row.chainId, row.tokenAddress);
