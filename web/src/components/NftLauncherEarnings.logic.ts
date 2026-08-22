/// Pure decision logic for NftLauncherEarnings.tsx — extracted so it can be
/// unit-tested with node --test + strip-types without needing a React tree
/// or wagmi provider. Same pattern as TokenHolderModules.logic.ts.
///
/// The component's job is a matrix of decisions:
///   - hide entirely unless viewing your own profile
///   - what to render while indexer is still loading
///   - what to render when the wallet has no NFT launches on this chain
///   - per-collection: show ETH row (if paymentToken == 0) or URU row
///   - claim button state: hidden (balance 0), 'claim' (on target chain, balance>0),
///     'switch→claim' (wrong chain, balance>0), 'claiming…' (tx pending for this row)
///
/// All of that is deterministic given (viewerWallet, connectedWallet, connectedChainId,
/// targetChainId, per-collection balances + payment mode, pending tx row) — no side
/// effects. That's what this module encodes.

import type { Address } from 'viem';

export type PaymentMode = 'eth' | 'uru';

export interface CollectionRow {
  /// Collection ERC-721 address — used as a stable key and shown as the row label.
  collectionAddress: Address;
  /// The NftMintModule address the launcher will call withdraw() / withdrawUru() on.
  mintModule: Address;
  /// Human-facing collection name from the indexer row.
  name: string;
  /// eth if paymentToken == 0x0, uru otherwise. Determines which button + balance to show.
  mode: PaymentMode;
  /// launcherBalance (ETH mode) or launcherBalanceUru (URU mode), in smallest unit.
  balance: bigint;
}

/// Overall widget visibility. Return false → render nothing (the earnings widget
/// leaks a wallet's income if shown on someone else's public profile).
export function isVisibleForViewer(
  viewerWallet: Address,
  connectedWallet: Address | undefined,
): boolean {
  if (!connectedWallet) return false;
  return viewerWallet.toLowerCase() === connectedWallet.toLowerCase();
}

/// Total unclaimed across every collection for one payment mode. Used to render
/// the header line "unclaimed: X ETH".
export function totalFor(mode: PaymentMode, rows: readonly CollectionRow[]): bigint {
  let total = 0n;
  for (const r of rows) {
    if (r.mode === mode) total += r.balance;
  }
  return total;
}

export type ClaimButtonState =
  /// Balance is zero — no button, just a dash.
  | { kind: 'none' }
  /// Wallet is on wrong chain — click switches, then user clicks again to claim.
  | { kind: 'switch' }
  /// Ready to submit the claim tx.
  | { kind: 'claim' }
  /// The claim tx for this specific row is in-flight (submitting or mining).
  | { kind: 'pending' };

/// State of the claim button for a single row. Encodes the full matrix so the
/// TSX just switches on the returned kind.
export function claimButtonState(
  row: CollectionRow,
  connectedChainId: number | undefined,
  targetChainId: number,
  pendingRowKey: string | null,
): ClaimButtonState {
  if (row.balance <= 0n) return { kind: 'none' };
  const thisRowKey = rowKey(row);
  if (pendingRowKey === thisRowKey) return { kind: 'pending' };
  if (connectedChainId !== targetChainId) return { kind: 'switch' };
  return { kind: 'claim' };
}

/// Stable per-row key. Same collection appears once per mode at most (ERC-721
/// clone binds one mint module, one payment mode is picked at launch), but we
/// include the mode in the key so accidental duplicates never collapse rows.
export function rowKey(row: Pick<CollectionRow, 'collectionAddress' | 'mode'>): string {
  return `${row.collectionAddress.toLowerCase()}:${row.mode}`;
}

/// Split raw indexer + on-chain state into the final row list the widget renders.
/// Collections whose launcher balance is zero in BOTH modes still surface —
/// launchers want to see their collection even before earnings accrue, so they
/// know the widget is working. Rows are ordered by (has-balance-desc, name-asc)
/// so anything actionable floats to the top.
export function buildRows(
  raw: ReadonlyArray<{
    collectionAddress: Address;
    mintModule: Address;
    name: string;
    paymentToken: Address; // 0x0 → ETH, else URU
    ethBalance: bigint;
    uruBalance: bigint;
  }>,
): CollectionRow[] {
  const rows: CollectionRow[] = [];
  const ZERO = '0x0000000000000000000000000000000000000000';
  for (const r of raw) {
    const isEth = r.paymentToken.toLowerCase() === ZERO;
    rows.push({
      collectionAddress: r.collectionAddress,
      mintModule: r.mintModule,
      name: r.name,
      mode: isEth ? 'eth' : 'uru',
      balance: isEth ? r.ethBalance : r.uruBalance,
    });
  }
  rows.sort((a, b) => {
    const aHas = a.balance > 0n ? 0 : 1;
    const bHas = b.balance > 0n ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    return a.name.localeCompare(b.name);
  });
  return rows;
}
