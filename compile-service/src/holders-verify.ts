/// Indexer-first holder sets, accepted ONLY when proven against the chain.
///
/// Why (2026-10-02): the compile-service's on-chain transfer scan runs over the
/// free public Robinhood RPC, which throttles hard (HTTP 429) — a live WL
/// snapshot of URU failed with "rpc http 429". The Ponder indexer already holds
/// holder balances for every token it tracks (launchpad ERC-20s, URU, urufu gemu
/// nft), so it is the fast path. But an incomplete indexer snapshot is exactly
/// the silently-partial failure that once locked ~0.11 ETH in a bad rewards
/// epoch, so indexer data is used only if:
///   (a) every holder's on-chain balanceOf equals the indexer balance
///       (catches wrong attribution), AND
///   (b) the balances sum to the contract's total supply (catches missing
///       holders): ERC-20 totalSupply(); ERC-721 totalSupply() when present;
///       urufu gemu nft (no totalSupply) its minted counters.
/// Anything else fails closed to the on-chain scan.

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';

import { rpcCall, type RpcOptions } from './holders-engine.ts';

export interface BalanceRow {
  address: string;
  balance: bigint;
}

export interface HolderVerification {
  ok: boolean;
  reason: string;
}

/// Canonical Multicall3, deployed on Robinhood (verified 2026-10-02).
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

/// urufu gemu nft (ChibiCoreV2) on Robinhood. Has no totalSupply(); see gemuMintedCount.
export const GEMU_NFT_ROBINHOOD = '0x60cb7082c8c14b4237c6a24c65e7c2e7abe2bd17' as const;

const abi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function MAX_AIRDROP_ID() view returns (uint256)',
  'function airdropMintedCount() view returns (uint256)',
  'function nextContinuationId() view returns (uint256)',
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

/// ChibiCoreV2 mints: airdrop ids 1..airdropMintedCount, continuation ids
/// MAX_AIRDROP_ID+1 .. nextContinuationId-1 (3,888 on 2026-10-02).
export function gemuMintedCount(maxAirdropId: bigint, airdropMinted: bigint, nextContinuationId: bigint): bigint {
  const continuation = nextContinuationId > maxAirdropId + 1n ? nextContinuationId - (maxAirdropId + 1n) : 0n;
  return airdropMinted + continuation;
}

/// Pure check. `label` names what `expectedTotal` is (minted / totalSupply) in
/// the reason string.
export function verifyHolderSnapshot<T extends BalanceRow>(
  holders: T[],
  onChainBalances: bigint[],
  expectedTotal: bigint,
  label = 'minted',
): HolderVerification {
  if (holders.length === 0) return { ok: false, reason: 'indexer returned no holders' };
  if (onChainBalances.length !== holders.length) return { ok: false, reason: 'balance read count mismatch' };
  let sum = 0n;
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i]!;
    const chain = onChainBalances[i]!;
    if (chain !== h.balance) {
      return { ok: false, reason: `balance mismatch for ${h.address}: indexer ${h.balance} vs chain ${chain}` };
    }
    sum += h.balance;
  }
  if (sum !== expectedTotal) return { ok: false, reason: `indexer total ${sum} != ${label} ${expectedTotal}` };
  return { ok: true, reason: `all ${holders.length} balances match chain; total ${sum} == ${label}` };
}

async function ethCall(rpcUrl: string, to: string, data: Hex, opts: RpcOptions): Promise<Hex> {
  return rpcCall<Hex>(rpcUrl, 'eth_call', [{ to, data }, 'latest'], opts);
}

async function readUint(
  rpcUrl: string,
  to: string,
  functionName: 'totalSupply' | 'MAX_AIRDROP_ID' | 'airdropMintedCount' | 'nextContinuationId',
  opts: RpcOptions,
): Promise<bigint> {
  const out = await ethCall(rpcUrl, to, encodeFunctionData({ abi, functionName }), opts);
  return decodeFunctionResult({ abi, functionName, data: out }) as bigint;
}

/// What the holder balances must sum to, or null if the contract exposes no
/// usable supply (then indexer data can't be proven complete).
export async function readExpectedTotal(
  rpcUrl: string,
  chainId: number,
  token: string,
  opts: RpcOptions = {},
): Promise<{ total: bigint; label: string } | null> {
  if (chainId === 4663 && token.toLowerCase() === GEMU_NFT_ROBINHOOD) {
    const [m, a, n] = await Promise.all([
      readUint(rpcUrl, token, 'MAX_AIRDROP_ID', opts),
      readUint(rpcUrl, token, 'airdropMintedCount', opts),
      readUint(rpcUrl, token, 'nextContinuationId', opts),
    ]);
    return { total: gemuMintedCount(m, a, n), label: 'minted' };
  }
  try {
    return { total: await readUint(rpcUrl, token, 'totalSupply', opts), label: 'totalSupply' };
  } catch {
    return null;
  }
}

/// balanceOf for every address via Multicall3 aggregate3, in chunks.
export async function readBalances(
  rpcUrl: string,
  token: string,
  addresses: string[],
  opts: RpcOptions = {},
  chunk = 500,
): Promise<bigint[]> {
  const out: bigint[] = [];
  for (let i = 0; i < addresses.length; i += chunk) {
    const calls = addresses.slice(i, i + chunk).map((a) => ({
      target: token as `0x${string}`,
      allowFailure: true,
      callData: encodeFunctionData({ abi, functionName: 'balanceOf', args: [a as `0x${string}`] }),
    }));
    const data = encodeFunctionData({ abi, functionName: 'aggregate3', args: [calls] });
    const raw = await ethCall(rpcUrl, MULTICALL3, data, opts);
    const results = decodeFunctionResult({ abi, functionName: 'aggregate3', data: raw }) as ReadonlyArray<{
      success: boolean;
      returnData: Hex;
    }>;
    for (const r of results) {
      if (!r.success) throw new Error('balanceOf failed inside multicall');
      out.push(decodeFunctionResult({ abi, functionName: 'balanceOf', data: r.returnData }) as bigint);
    }
  }
  return out;
}

export interface IndexerHoldersOptions {
  /// Indexer base URL (no /graphql). Default env INDEXER_URL.
  indexerUrl?: string;
  fetchImpl?: typeof fetch;
  /// Refuse sets larger than this (default 100,000).
  cap?: number;
  pageSize?: number;
}

/// Every holder (balance > 0) of `token` from the indexer's `holders` table.
export async function fetchIndexerHolders(
  chainId: number,
  token: string,
  opts: IndexerHoldersOptions = {},
): Promise<BalanceRow[]> {
  const base = opts.indexerUrl ?? process.env.INDEXER_URL;
  if (!base) return [];
  const f = opts.fetchImpl ?? fetch;
  const pageSize = opts.pageSize ?? 1000;
  const cap = opts.cap ?? 100_000;
  const query = `
    query Holders($chainId: Int!, $token: String!, $limit: Int!, $after: String) {
      holderss(
        where: { chainId: $chainId, tokenAddress: $token }
        orderBy: "id"
        orderDirection: "asc"
        limit: $limit
        after: $after
      ) {
        items { holderAddress balance }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const rows: BalanceRow[] = [];
  let after: string | null = null;
  for (;;) {
    const res = await f(`${base.replace(/\/$/, '')}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { chainId, token: token.toLowerCase(), limit: pageSize, after } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const json = (await res.json()) as {
      data?: { holderss: { items: Array<{ holderAddress: string; balance: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      errors?: unknown;
    };
    if (json.errors) throw new Error(`indexer errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
    const items = json.data?.holderss.items ?? [];
    for (const row of items) {
      const balance = BigInt(row.balance);
      if (balance <= 0n) continue;
      rows.push({ address: row.holderAddress.toLowerCase(), balance });
      if (rows.length > cap) throw new Error(`indexer holder count exceeds cap ${cap}`);
    }
    const page = json.data?.holderss.pageInfo;
    if (!page?.hasNextPage || items.length < pageSize || !page.endCursor) break;
    after = page.endCursor;
  }
  return rows;
}

export interface VerifiedIndexerResult {
  holders: BalanceRow[];
  verification: HolderVerification;
}

/// Indexer holders for `token`, plus whether they are proven complete and
/// correct against the chain. Callers must only use `holders` when
/// `verification.ok`. One re-try absorbs a transfer that landed between the
/// indexer read and the chain read.
export async function verifiedIndexerHolders(
  args: { chainId: number; token: string; rpcUrl: string },
  opts: RpcOptions & IndexerHoldersOptions = {},
): Promise<VerifiedIndexerResult> {
  let last: VerifiedIndexerResult = { holders: [], verification: { ok: false, reason: 'not attempted' } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const holders = await fetchIndexerHolders(args.chainId, args.token, opts);
    if (holders.length === 0) return { holders, verification: { ok: false, reason: 'indexer has no holders for this token' } };
    const expected = await readExpectedTotal(args.rpcUrl, args.chainId, args.token, opts);
    if (!expected) return { holders, verification: { ok: false, reason: 'contract exposes no total supply to verify against' } };
    const balances = await readBalances(args.rpcUrl, args.token, holders.map((h) => h.address), opts);
    last = { holders, verification: verifyHolderSnapshot(holders, balances, expected.total, expected.label) };
    if (last.verification.ok) return last;
  }
  return last;
}
