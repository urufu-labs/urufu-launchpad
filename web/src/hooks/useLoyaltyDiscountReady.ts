'use client';

/// Loyalty-discount readiness — Layer 3 (UI live-read) of the release gate
/// stack for GH #10.
///
/// The fork test (Layer 1) proves that on the LIVE chain the wiring holds:
/// Router.loyaltyOracle() != 0, LoyaltyOracle.uruToken/gemuNft match the
/// canonical addresses. But the fork test runs at CI time. This hook runs
/// on the client at page-load and re-verifies the same wiring against the
/// CONNECTED chain. If wiring has drifted since deploy — a mis-set setter,
/// a swapped-in oracle that points at pre-migration addresses, an RPC that
/// only reads code from an old snapshot — this hook returns `ready:false`
/// with a human reason and every discount-copy consumer degrades.
///
/// Consumers wrap discount % copy behind `ready === true`. Failure paths
/// hide the copy or show a placeholder — the frontend never renders a
/// specific discount % that isn't backed by a live-read verification.
///
/// Caching:
///   - result cached per (chainId, routerAddress) tuple for 30s
///   - refetches on chain/connect change (the react-query key includes both)
///   - uses tanstack-query's built-in dedup so co-mounted consumers make
///     ONE round-trip per chain per 30s window regardless of how many
///     components ask.

import { useMemo } from 'react';
import { type Address } from 'viem';
import { useAccount, usePublicClient } from 'wagmi';
import { useQuery } from '@tanstack/react-query';

import { CONTRACTS, ECOSYSTEM_TOKENS, FLYWHEEL } from '@/lib/config';
import { routerAbi } from '@/lib/abis';
import { CHAIN_ID_TO_KEY } from '@/lib/wagmi';

export interface LoyaltyReadiness {
  /// True only when every wiring check passed and the on-chain oracle
  /// address matches what the ecosystem-token config expects.
  ready: boolean;
  /// Human-readable failure reason. Populated on `ready === false`; safe
  /// to render as tooltip / caption. `undefined` when ready.
  reason?: string;
  /// True while the initial read is in flight. Consumers may prefer to
  /// hide entirely rather than flash "loading" for the ~50-200ms it takes.
  loading: boolean;
}

/// Minimal LoyaltyOracle read surface. Kept inline (rather than in
/// `abis.ts`) because it's the only place the hook needs it and pulling
/// the full oracle ABI would drag in setter selectors nothing else calls.
const LOYALTY_ORACLE_READ_ABI = [
  {
    type: 'function',
    name: 'uruToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'gemuNft',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const ZERO = '0x0000000000000000000000000000000000000000';

function eq(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/// Returns the readiness state for the wallet's currently connected chain.
/// When no wallet is connected the hook returns `ready: false` with a
/// benign reason so consumers can degrade uniformly (no copy shown until
/// the user connects and we can prove wiring live).
export function useLoyaltyDiscountReady(): LoyaltyReadiness {
  const { chainId } = useAccount();
  // usePublicClient() without a chainId defaults to the connected chain's
  // client — same client wagmi hands to useReadContract when no chainId
  // is passed. Passing chainId typed as `number | undefined` fails the
  // strict union check (wagmi wants a member of the configured chain-id
  // literal set) and cast churn isn't worth it here.
  const publicClient = usePublicClient();

  const chainKey = chainId != null ? CHAIN_ID_TO_KEY[chainId] : undefined;
  const contracts = chainKey ? CONTRACTS[chainKey] : null;
  const flywheel = chainKey ? FLYWHEEL[chainKey] : null;
  const expected = chainKey ? ECOSYSTEM_TOKENS[chainKey] : null;
  const routerAddress = contracts?.Router;

  const query = useQuery<LoyaltyReadiness>({
    // (chainId, routerAddress) tuple keys the cache — swapping either
    // invalidates and forces a refetch.
    queryKey: ['loyalty-discount-ready', chainId ?? null, routerAddress ?? null],
    enabled: !!publicClient && !!routerAddress && !!expected,
    // 30s cache: hard requirement from GH #10. Slower than a per-second
    // heartbeat, faster than "read once ever" so a mid-session rotation
    // gets picked up within a page's typical lifetime.
    staleTime: 30_000,
    gcTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<LoyaltyReadiness> => {
      if (!publicClient || !routerAddress || !expected) {
        return { ready: false, reason: 'chain not supported', loading: false };
      }
      try {
        // Router.loyaltyOracle() — wired?
        const wiredOracle = (await publicClient.readContract({
          address: routerAddress,
          abi: routerAbi,
          functionName: 'loyaltyOracle',
        })) as Address;
        if (!wiredOracle || wiredOracle === ZERO) {
          return {
            ready: false,
            reason: 'router has no loyalty oracle wired',
            loading: false,
          };
        }
        // Basic sanity: oracle address has code on the connected chain.
        // Catches the case where wiring points at a not-yet-deployed
        // address or an RPC that's serving stale state.
        const oracleCode = await publicClient.getCode({ address: wiredOracle });
        if (!oracleCode || oracleCode === '0x') {
          return {
            ready: false,
            reason: 'wired oracle has no code on this rpc',
            loading: false,
          };
        }
        // Optional cross-check: the config-declared LoyaltyOracle should
        // match what Router.loyaltyOracle returns. Belt-and-braces so an
        // RPC that read a stale wiring gets flagged.
        if (flywheel?.LoyaltyOracle && !eq(wiredOracle, flywheel.LoyaltyOracle)) {
          return {
            ready: false,
            reason: 'wired oracle differs from config pin',
            loading: false,
          };
        }
        // Oracle points at the URU + GEMU we expect for this chain?
        const [uruToken, gemuNft] = await Promise.all([
          publicClient.readContract({
            address: wiredOracle,
            abi: LOYALTY_ORACLE_READ_ABI,
            functionName: 'uruToken',
          }) as Promise<Address>,
          publicClient.readContract({
            address: wiredOracle,
            abi: LOYALTY_ORACLE_READ_ABI,
            functionName: 'gemuNft',
          }) as Promise<Address>,
        ]);
        if (!uruToken || uruToken === ZERO || !eq(uruToken, expected.uruToken)) {
          return {
            ready: false,
            reason: 'oracle points at wrong URU token',
            loading: false,
          };
        }
        if (!gemuNft || gemuNft === ZERO || !eq(gemuNft, expected.gemuNft)) {
          return {
            ready: false,
            reason: 'oracle points at wrong urufu gemu NFT',
            loading: false,
          };
        }
        // Sanity: those addresses hold code on the RPC we're reading.
        // Otherwise a stale RPC could return an address that's "right"
        // by the config but has no bytecode to run against.
        const [uruCode, gemuCode] = await Promise.all([
          publicClient.getCode({ address: uruToken }),
          publicClient.getCode({ address: gemuNft }),
        ]);
        if (!uruCode || uruCode === '0x') {
          return {
            ready: false,
            reason: 'URU token address has no code on this rpc',
            loading: false,
          };
        }
        if (!gemuCode || gemuCode === '0x') {
          return {
            ready: false,
            reason: 'gemu NFT address has no code on this rpc',
            loading: false,
          };
        }
        return { ready: true, loading: false };
      } catch (err) {
        // Any RPC failure = degrade closed. Never lie about discount
        // readiness because a read timed out.
        return {
          ready: false,
          reason: err instanceof Error ? `rpc error: ${err.message.slice(0, 80)}` : 'rpc error',
          loading: false,
        };
      }
    },
  });

  // Merge query.isPending into the returned loading bit so consumers can
  // distinguish "fetching first result" from "cached failure" without
  // reaching into react-query internals.
  return useMemo<LoyaltyReadiness>(() => {
    if (query.data) return { ...query.data, loading: query.isFetching && query.isPending };
    if (query.isPending && query.fetchStatus !== 'idle') {
      return { ready: false, loading: true };
    }
    // Not enabled (no chain, no router, no ecosystem tokens) — degrade
    // without a spinner.
    return { ready: false, reason: 'chain not supported', loading: false };
  }, [query.data, query.isPending, query.isFetching, query.fetchStatus]);
}
