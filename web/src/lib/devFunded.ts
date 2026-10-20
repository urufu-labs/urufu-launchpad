/// "Wallets funded by the dev" heuristic for Fair launch tokens (limit 1 in
/// docs/REVIEW-fair-launch-2026-10-20.md). On-chain code cannot link a dev to the
/// fresh wallets they fund, so the trade page flags them instead: any opening-batch
/// depositor or early buyer that the creator wallet sent ETH or this token to,
/// shortly before or after launch.
///
/// Data source: Robinhood's Blockscout v2 API, called from the visitor's BROWSER.
/// The API sits behind a Cloudflare check that blocks servers (see the compile
/// service's demoted Blockscout fallback), but it allows cross-origin browser
/// reads. Nothing here is trusted by contracts; it is a warning only.
///
/// What it does NOT catch: funding through an exchange, a bridge, or a second hop
/// wallet. The UI says so.

export const BLOCKSCOUT_API = 'https://robinhoodchain.blockscout.com/api/v2';

/// How far before the launch a funding transfer still counts.
export const FUNDING_LOOKBACK_SECS = 3 * 24 * 60 * 60;
/// Max Blockscout pages read per list (50 items each).
export const MAX_PAGES = 6;

export interface BsTx {
  timestamp?: string | null;
  value?: string | null;
  to?: { hash?: string | null } | null;
}

export interface BsTokenTransfer {
  timestamp?: string | null;
  to?: { hash?: string | null } | null;
  token?: { address_hash?: string | null; address?: string | null } | null;
}

interface Page<T> {
  items?: T[];
  next_page_params?: Record<string, string | number> | null;
}

/// Recipients of ETH (value > 0) from `txs` at or after `sinceTs` (unix seconds).
export function ethRecipients(txs: BsTx[], sinceTs: number): Set<string> {
  const out = new Set<string>();
  for (const t of txs) {
    const to = t.to?.hash?.toLowerCase();
    if (!to) continue;
    if (!t.value || BigInt(t.value) === 0n) continue;
    if (t.timestamp && Date.parse(t.timestamp) / 1000 < sinceTs) continue;
    out.add(to);
  }
  return out;
}

/// Recipients of `token` transfers from the creator at or after `sinceTs`.
export function tokenRecipients(transfers: BsTokenTransfer[], token: string, sinceTs: number): Set<string> {
  const want = token.toLowerCase();
  const out = new Set<string>();
  for (const t of transfers) {
    const addr = (t.token?.address_hash ?? t.token?.address ?? '').toLowerCase();
    if (addr !== want) continue;
    const to = t.to?.hash?.toLowerCase();
    if (!to) continue;
    if (t.timestamp && Date.parse(t.timestamp) / 1000 < sinceTs) continue;
    out.add(to);
  }
  return out;
}

/// Candidates (depositors / early buyers) that appear in either recipient set.
/// Never flags the creator itself or contracts we know about (`ignore`).
export function matchFunded(
  candidates: string[],
  recipients: Set<string>[],
  creator: string,
  ignore: string[] = [],
): string[] {
  const skip = new Set([creator.toLowerCase(), ...ignore.map((a) => a.toLowerCase())]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const a = c.toLowerCase();
    if (skip.has(a) || seen.has(a)) continue;
    seen.add(a);
    if (recipients.some((r) => r.has(a))) out.push(a);
  }
  return out;
}

async function readPages<T extends { timestamp?: string | null }>(
  url: string,
  sinceTs: number,
  fetchImpl: typeof fetch,
): Promise<T[]> {
  const items: T[] = [];
  let next: Record<string, string | number> | null | undefined = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = next ? `&${new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)]))}` : '';
    const res = await fetchImpl(`${url}${q}`, { headers: { accept: 'application/json' } });
    if (!res.ok) break;
    const body = (await res.json()) as Page<T>;
    const batch = body.items ?? [];
    items.push(...batch);
    // Lists are newest first: stop once we are past the lookback window.
    const last = batch[batch.length - 1];
    if (!body.next_page_params || (last?.timestamp && Date.parse(last.timestamp) / 1000 < sinceTs)) break;
    next = body.next_page_params;
  }
  return items;
}

/// Full lookup. Returns the flagged addresses (lowercase), or null if Blockscout
/// could not be read (the UI then says the check is unavailable).
export async function findDevFundedWallets(params: {
  creator: string;
  token: string;
  launchTs: number;
  candidates: string[];
  ignore?: string[];
  fetchImpl?: typeof fetch;
}): Promise<string[] | null> {
  const f = params.fetchImpl ?? fetch;
  const sinceTs = params.launchTs - FUNDING_LOOKBACK_SECS;
  const base = `${BLOCKSCOUT_API}/addresses/${params.creator}`;
  try {
    const [txs, transfers] = await Promise.all([
      readPages<BsTx>(`${base}/transactions?filter=from`, sinceTs, f),
      readPages<BsTokenTransfer>(`${base}/token-transfers?type=ERC-20&filter=from&token=${params.token}`, sinceTs, f),
    ]);
    return matchFunded(
      params.candidates,
      [ethRecipients(txs, sinceTs), tokenRecipients(transfers, params.token, sinceTs)],
      params.creator,
      params.ignore,
    );
  } catch {
    return null;
  }
}
