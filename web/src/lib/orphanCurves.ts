/// Snapshot of every bonding-curve on Robinhood that is NOT graduated and
/// still holds ETH, but whose CurveFactory is no longer wired to the current
/// launchpad UI. Buyers of these tokens still own their ERC20 balance; the
/// ETH they paid is still in the curve; sell() still works. The /recover
/// page walks holders through the approve + sell flow so they can pull
/// their ETH back out.
///
/// Data source: contracts/tools/sweepOrphans.py against every historical CF
/// on RH. Refresh by re-running the script and pasting the resulting JSON
/// here (see below). This list won't grow — every current + future launch
/// uses the live V8 CF (0x1c34...) which is wired into the main app.
///
/// Coverage proven by contracts/test/audit/OrphanRecoveryFork.t.sol — that
/// test impersonates a real URUFU holder against a live RH fork and
/// confirms approve + sell returns ETH to the holder.
///
/// Refreshing:
///   1. Run `python contracts/tools/sweepOrphans.py > /tmp/orphans.json`
///   2. Paste the `orphans` array below (mind the field types — balanceWei
///      is a string here so it survives JSON round-trip without precision
///      loss; convert to BigInt in the component).
///   3. Bump `SWEPT_AT_BLOCK` to the returned `sweptAt` value.

import type { Address } from 'viem';

export interface OrphanCurve {
    /// ERC20 token address holders can sell back.
    token: Address;
    /// BondingCurve contract to approve + call sell() on.
    curve: Address;
    /// CurveFactory that created this curve. Not called from the UI —
    /// shown for on-chain diligence (users can verify the pair).
    factory: Address;
    /// Address that originally launched the token (informational).
    launcher: Address;
    /// ERC20 name(), verbatim from on-chain.
    tokenName: string;
    /// ERC20 symbol(), verbatim from on-chain.
    tokenSymbol: string;
    /// Curve's ETH balance at snapshot time, wei as decimal string.
    /// Live balance is re-fetched by the UI, so treat this as a hint
    /// for sorting / disabling.
    balanceWeiAtSnapshot: string;
}

export const SWEPT_AT_BLOCK = 24245385;

export const ORPHAN_CURVES: OrphanCurve[] = [
    {
        token: '0x5DABF92def16A33B3aCee2676b966Bf4d0e13996',
        curve: '0xef68EF6927E9896ad8808f4B0E4c1d63dEF888CC',
        factory: '0x4631C21b066D3B289779e477fc79f13E8d0Fc248',
        launcher: '0x6d606cc634F20f5534fba072757F2c2C7B835Bb9',
        tokenName: 'iloveuru',
        tokenSymbol: 'WOWURU',
        balanceWeiAtSnapshot: '330213109818754996',
    },
    {
        token: '0x193EA86260519589cF67ED9E45fCCC5509d11842',
        curve: '0x522c5B368E5cc8149dBEfd2Da99284A601Ab8505',
        factory: '0xFfda6614A6d527eb1e0b19C6B9DbdD1e243A1904',
        launcher: '0x0a001467B0E3a2218E3AFcA5A7e44B61d6AcE57E',
        tokenName: 'URUFU',
        tokenSymbol: 'URAFU',
        balanceWeiAtSnapshot: '1304339708055485638',
    },
    {
        token: '0x9FcD5B654c0d3a809A8636B0cb7fdC46E7Fc6628',
        curve: '0x0849A5305CDCc4e32420506dE92990471a028e7a',
        factory: '0xFfda6614A6d527eb1e0b19C6B9DbdD1e243A1904',
        launcher: '0x0a001467B0E3a2218E3AFcA5A7e44B61d6AcE57E',
        tokenName: 'spoobs',
        tokenSymbol: 'SPOOBS',
        balanceWeiAtSnapshot: '607860000000000000',
    },
    {
        token: '0x4895B5D9Aa944b0764de4Db7EA84f2a90602cF2C',
        curve: '0xCBA3Ad3ACEFEA65f4cD4FBfB2b547b5C7E38A79e',
        factory: '0xFfda6614A6d527eb1e0b19C6B9DbdD1e243A1904',
        launcher: '0x0a001467B0E3a2218E3AFcA5A7e44B61d6AcE57E',
        tokenName: 'TEST',
        tokenSymbol: 'URUFU',
        balanceWeiAtSnapshot: '227700000000000000',
    },
];

/// Minimal ABI slice for the sell + approve flow the /recover page uses.
/// Curves and tokens across every historical CF share this shape (the
/// BondingCurve source has been stable on these calls since V2).
export const ORPHAN_CURVE_ABI = [
    {
        type: 'function',
        name: 'sell',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'tokensIn', type: 'uint256' },
            { name: 'minEthOut', type: 'uint256' },
        ],
        outputs: [{ name: 'ethOut', type: 'uint256' }],
    },
    { type: 'function', name: 'graduated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'ethReserve', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'tokenReserve', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'virtualEthReserve', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    {
        type: 'function',
        name: 'virtualTokenReserve',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint256' }],
    },
    { type: 'function', name: 'tradeFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
] as const;

export const ORPHAN_TOKEN_ABI = [
    {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'owner', type: 'address' }],
        outputs: [{ type: 'uint256' }],
    },
    {
        type: 'function',
        name: 'approve',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
    },
    {
        type: 'function',
        name: 'allowance',
        stateMutability: 'view',
        inputs: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
        ],
        outputs: [{ type: 'uint256' }],
    },
] as const;

/// Search helper — matches an entry by any of: token address, curve address,
/// name (case-insensitive substring), symbol (case-insensitive substring).
/// Empty query returns everything.
export function searchOrphans(query: string): OrphanCurve[] {
    const q = query.trim().toLowerCase();
    if (!q) return ORPHAN_CURVES;
    return ORPHAN_CURVES.filter((o) => {
        return (
            o.token.toLowerCase().includes(q) ||
            o.curve.toLowerCase().includes(q) ||
            o.tokenName.toLowerCase().includes(q) ||
            o.tokenSymbol.toLowerCase().includes(q)
        );
    });
}
