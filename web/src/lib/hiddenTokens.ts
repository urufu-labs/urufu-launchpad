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
///   - V6 smoke launches on Robinhood (V6SmokeLaunch + V6SmokeMatrix's 19
///     tokens broadcast 2026-07-26 to prove module coverage on live V6).
///     Real launches by the same deployer wallet stay visible — we filter
///     by explicit address, not launcher, so testing continues to work.

import type { Address } from 'viem';

export const HIDDEN_TOKENS: ReadonlySet<string> = new Set<string>([
  '8453:0xde1323b369b362bc1ad3d036bef964279e8eb1c7',
  '84532:0x92462af2c2c8d2a18dcbbddd66c8aa401ec2de6d',
  // V6 Smoke Bare (V6SmokeLaunch.s.sol, block 21058832)
  '4663:0x6015e615e9372eeca79261edaae7925b64f52a2d',
  // V6SmokeMatrix's 18 module-coverage launches (blocks 21065217 - 21065584)
  '4663:0x07aaa059b16f8c09a3b20fa2c4cace74cdab13f3',
  '4663:0xc53139d52b79076168b93bc395ed47bbd3e22a0a',
  '4663:0x1305f7ce2e9e71c96e0b8d4f7b283ab10d3bf277',
  '4663:0x842410b8facb014dd12840bf4fa01fe6a827269c',
  '4663:0xd6738a85752021f7fad12563eee40055cd485637',
  '4663:0xfc3c3b152d14ec974ce21706fbc6bc8013fc537d',
  '4663:0x4d7cfe1a9417f578cbe4c30058b562322c110fda',
  '4663:0x592bb65f693eb60b92501dbcbbc25e0f3f6ef8b1',
  '4663:0x74cb7050deda12dd14fd421fee2470d867fd3b18',
  '4663:0x5ef2c2db535fe749ee639823ab9ceca4f84514a3',
  '4663:0x4cc3615855b3f90b7aec3d7029d3314fa6417349',
  '4663:0x841ef4cefe0ebfb87c994c1a6a71fee953406333',
  '4663:0xfb6bc3ce8974ec6ff88c100593f77ba73940f470',
  '4663:0x2969c9502c7dbe8797ab625249396f4bb12ad9e2',
  '4663:0x2a8e0ae521f7148b9353bb562fc3c8de8c52205a',
  '4663:0x2c68eda3644f8e4ff078ebcec6b5c28d0c0d6f09',
  '4663:0x55e81c3b6a626ce1442b1d5cedcbfb134cdf2c10',
  '4663:0x607e981d4bf3882b817fe3bc75c5fad9fde259a5',
  // testToken $TEST — the pre-GraduatorV2 test launch that graduated with
  // the 500x cliff. Hidden so it doesn't clutter discover / marquee / profile
  // while we run a fresh graduation test through GraduatorV2.
  '4663:0xe13a416dc7e679de10c476c70d0f6e5373752567',
  // $FDGDFVS + $TIGER — both curves were created after CurveFactory was
  // rewired to a mismatched-MHH GraduatorV2. Every graduation reverts with
  // MultiHookHost__UnauthorizedInitializer, so these curves are stuck in
  // bonding phase forever. Hidden until we relaunch through the V5 MHH+
  // Graduator pair.
  '4663:0x4b44ecc4d83b50495b641bff8cc04a7fa99b754d',
  '4663:0xdaad3893f3a12eacd2809b8da37ad6b8715f1ef3',
  // PROOF (AllowlistProof) — V9 production-MHH graduation proof for Uniswap
  // Labs hook allowlist submission. Not a real launch; do not surface.
  '4663:0xab353c75f1025fb5a38900976f1927cd21516673',
  // Post-audit smoke tests of Router entrypoints (2026-08-09). WlTest exercises
  // launchWithWhitelist, UruPayTest exercises launchWithURU, PlainTest exercises
  // the plain launch() path. Kept off feeds; not real launches.
  '4663:0x54a78c6e50ba973f6fca90e1ad26300d6213eb7d', // WlTest / WLT
  '4663:0x976faed1371f8d023ff9f9196d59525390ee9871', // UruPayTest / URUP
  '4663:0xa203d536d0dae1af5c849060e29933c9cbd8792a', // PlainTest / PLAIN
  // Second smoke round (2026-08-09): real enforcement tests for WL, ownership
  // modes, URU+WL combined, pause, anti-sniper, buyback-burn. All burner-signed,
  // all proven working; none real launches.
  '4663:0x97884fd38714e1b04e7ca8478efabe94eb9bcb1b', // WlEnforce / WLE
  '4663:0x69d8d8bfd7047aff2e797fcf8d0976c48b625174', // OwnMulti / OMS (TransferToMultisig)
  '4663:0x103f2091436484d544b7219b73dafd01e66c0a52', // OwnKeep / OKP (KeepEOA)
  '4663:0x6cc69af91c5319e166fcc450642476fa0a7bb23e', // UruWlTest / URUWL
  '4663:0x9f84a56f43e9b4866705a3795720bf6d33482112', // ShouldFail / NOPE (pause round-trip proof)
  '4663:0xa363f7613ac1f26620416cd87b62e819cb8fc581', // AntiSniperTest / AST (buybackBurn=500)
  '4663:0x4d265f95c736901236414aae0fa732033a72d353', // SniperGate / SGATE (antiSniperBlocks=200)
  '4663:0xf3da40a10af1d16d9bc0686c86cbb6c6bfae2334', // SniperOne / SGONE (antiSniperBlocks=1)
  '4663:0x75320e4b9811054c07baf24e368097d9e4c2517c', // Sniper60 / S60 (antiSniperBlocks=5 = ~60s gate, verified 49-64s empirical)
  '4663:0x58dd2e72f87717a130091b93f7e490233e8bc8bd', // AgentSmoke / ASMK (end-to-end test of /api/agent/* — real calldata from /quote, verified via /verify)
  '4663:0x4839868e2f20bb69842436a3f960356e987248cf', // AgentPicTest / APIC (full pipeline w/ real image + description + socials attached via agent APIs)
]);

export function isHiddenToken(chainId: number, tokenAddress: Address | string): boolean {
  const addr = typeof tokenAddress === 'string' ? tokenAddress.toLowerCase() : (tokenAddress as string).toLowerCase();
  return HIDDEN_TOKENS.has(`${chainId}:${addr}`);
}

/// Curried filter for `.filter()` callbacks on rows that carry both fields.
export const notHidden = <T extends { chainId: number; tokenAddress: Address | string }>(row: T): boolean =>
  !isHiddenToken(row.chainId, row.tokenAddress);

/// Chain-agnostic address check — for the trade page which resolves the token's
/// home chain asynchronously (via indexer or wallet chain) and needs a same-frame
/// answer to decide whether to render the "retired" splash vs the live UI.
/// Matches any HIDDEN_TOKENS entry whose address suffix matches the input.
export function isHiddenAddressAnywhere(tokenAddress: Address | string): boolean {
  const addr = (typeof tokenAddress === 'string' ? tokenAddress : (tokenAddress as string)).toLowerCase();
  for (const key of HIDDEN_TOKENS) {
    if (key.endsWith(':' + addr)) return true;
  }
  return false;
}
