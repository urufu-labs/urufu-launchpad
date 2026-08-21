/// NFT cross-chain discount attestation endpoint.
///
/// A launched NFT collection can carry discount tiers that scale with
/// how many of an EXTERNAL NFT the buyer holds — where "external" may
/// live on a different chain than the launch. On-chain we can't read
/// balances across chains, so the mint module trusts a signed
/// attestation from this service.
///
/// Flow (buyer clicks "mint" with an ExternalNft tier claimed):
///   1. Frontend POSTs {chainId, wallet, ourCollection, targetCollection,
///      targetChainId, tierId} here.
///   2. Service reads `IERC721.balanceOf(wallet)` on `targetCollection`
///      at the current block of `targetChainId`.
///   3. Service signs `keccak256(abi.encode("URU_NFT_DISCOUNT_V1",
///      block.chainid, wallet, ourCollection, targetCollection,
///      targetChainId, tierId, count, expiry))` with the compile-service
///      signing key (KEEPER_PRIVATE_KEY).
///   4. Returns `{count, expiry, sig}` to the frontend, which passes it
///      into `NftMintModule.mint(...)` as one of the TierProof entries.
///
/// The on-chain hash MUST byte-for-byte match `attestationHash` in
/// `contracts/src/nft/NftDiscountVerifier.sol`. See the constant string
/// `URU_NFT_DISCOUNT_V1` — do not change without a coordinated
/// contract redeploy.
///
/// Threat model: this endpoint's blast radius is "grant an incorrect
/// discount". Not "mint free NFTs" — the module still charges the
/// discounted price, and discount is capped at (100% - discountFloorBps)
/// so a compromised signer can at worst make mints free FOR THE CAP.
/// Deployers who care about that ceiling set a discountFloor > 0.
///
/// Rate-limit: reuses the global fastify-rate-limit budget already
/// configured on the app, plus a per-wallet cache so repeated mint
/// clicks within `ATTESTATION_CACHE_MS` return the same sig instead of
/// hammering the target chain's RPC.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createPublicClient,
  http,
  isAddress,
  keccak256,
  encodeAbiParameters,
  toHex,
  type Address,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// -----------------------------------------------------------------------------
// Chain config — each external chain we can attest to needs an RPC URL. Reads
// from env vars matching the ecosystem convention (ROBINHOOD_RPC_URL, etc.).
// -----------------------------------------------------------------------------

interface ExternalChain {
  chainId: number;
  slug: string;
  rpcUrl: string;
}

function externalChains(): ExternalChain[] {
  const chains: ExternalChain[] = [];
  const eth = process.env.ETH_RPC_URL ?? process.env.MAINNET_RPC_URL;
  if (eth) chains.push({ chainId: 1, slug: 'ethereum', rpcUrl: eth });
  const base = process.env.BASE_RPC_URL;
  if (base) chains.push({ chainId: 8453, slug: 'base', rpcUrl: base });
  const rh = process.env.ROBINHOOD_RPC_URL;
  if (rh) chains.push({ chainId: 4663, slug: 'robinhood', rpcUrl: rh });
  return chains;
}

function chainById(id: number): ExternalChain | undefined {
  return externalChains().find((c) => c.chainId === id);
}

// -----------------------------------------------------------------------------
// Attestation hash — MUST match NftDiscountVerifier.attestationHash byte-for-byte.
// -----------------------------------------------------------------------------

const ATTESTATION_TAG = 'URU_NFT_DISCOUNT_V1';

function attestationHash(input: {
  callerChainId: number;
  wallet: Address;
  ourCollection: Address;
  targetCollection: Address;
  targetChainId: number;
  tierId: bigint;
  count: bigint;
  expiry: bigint;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        ATTESTATION_TAG,
        BigInt(input.callerChainId),
        input.wallet,
        input.ourCollection,
        input.targetCollection,
        BigInt(input.targetChainId),
        input.tierId,
        input.count,
        input.expiry,
      ],
    ),
  );
}

// -----------------------------------------------------------------------------
// Per-wallet cache — same wallet clicking "mint" 5 times in 30s gets the same
// signed attestation so we don't hammer the target chain's RPC unnecessarily.
// Cache key includes every input that goes into the sig hash so a
// tierId/collection change fetches a fresh reading.
// -----------------------------------------------------------------------------

interface CacheEntry {
  count: bigint;
  expiry: bigint;
  sig: `0x${string}`;
  cachedAt: number;
}

const ATTESTATION_CACHE_MS = 30_000;    // 30s freshness window
const ATTESTATION_EXPIRY_MS = 15 * 60_000;    // 15min sig lifetime
const cache = new Map<string, CacheEntry>();

function cacheKey(o: {
  callerChainId: number;
  wallet: Address;
  ourCollection: Address;
  targetCollection: Address;
  targetChainId: number;
  tierId: bigint;
}): string {
  return `${o.callerChainId}:${o.wallet.toLowerCase()}:${o.ourCollection.toLowerCase()}:${o.targetCollection.toLowerCase()}:${o.targetChainId}:${o.tierId}`;
}

// -----------------------------------------------------------------------------
// Public client cache (one PublicClient per chain, reused across requests)
// -----------------------------------------------------------------------------

const publicClients = new Map<number, PublicClient>();

function clientFor(chain: ExternalChain): PublicClient {
  const cached = publicClients.get(chain.chainId);
  if (cached) return cached;
  const client = createPublicClient({ transport: http(chain.rpcUrl) });
  publicClients.set(chain.chainId, client);
  return client;
}

const balanceOfAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// -----------------------------------------------------------------------------
// Route
// -----------------------------------------------------------------------------

const AttestBody = z.object({
  /// The chain the mint tx will land on — this is embedded in the sig
  /// hash as `block.chainid` so the sig can never be replayed on a
  /// different chain (matches NftDiscountVerifier.attestationHash).
  callerChainId: z.number().int().positive(),
  wallet: z.string().refine((s) => isAddress(s), { message: 'not an EVM address' }),
  ourCollection: z
    .string()
    .refine((s) => isAddress(s), { message: 'not an EVM address' }),
  targetCollection: z
    .string()
    .refine((s) => isAddress(s), { message: 'not an EVM address' }),
  targetChainId: z.number().int().positive(),
  tierId: z.number().int().nonnegative(),
});

export async function registerNftDiscountAttestRoutes(app: FastifyInstance): Promise<void> {
  // Signing key. Reused from the keeper — its blast radius already
  // includes signing txs from the vault-owner wallet, so widening it to
  // sign discount attestations is a strict subset of what it already can
  // do. If we ever split concerns, add a dedicated ATTESTATION_PRIVATE_KEY.
  //
  // Robustness: normalize the 0x prefix (some deploys store the key without
  // it, some with) and NEVER let a malformed key crash the whole server at
  // startup — that would take down every other compile-service route
  // (token image uploads, rewards, keeper, WL snapshots). Malformed →
  // signer=null → endpoint 503s while the rest of the service keeps running.
  const rawKey = process.env.KEEPER_PRIVATE_KEY;
  let signer: ReturnType<typeof privateKeyToAccount> | null = null;
  if (!rawKey) {
    app.log.warn(
      'NFT discount attest: KEEPER_PRIVATE_KEY unset — endpoint will 503 until configured',
    );
  } else {
    const normalized = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;
    try {
      signer = privateKeyToAccount(normalized);
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'NFT discount attest: KEEPER_PRIVATE_KEY malformed — endpoint will 503 until fixed',
      );
    }
  }

  app.post('/api/nft-discount/attest', async (req, reply) => {
    if (!signer) {
      return reply.code(503).send({
        error: 'attestation service not configured',
        code: 'SIGNER_UNSET',
      });
    }
    const parsed = AttestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'bad request body',
        details: parsed.error.flatten(),
      });
    }
    const body = parsed.data;
    const wallet = body.wallet as Address;
    const ourCollection = body.ourCollection as Address;
    const targetCollection = body.targetCollection as Address;
    const tierIdBig = BigInt(body.tierId);

    const target = chainById(body.targetChainId);
    if (!target) {
      return reply.code(400).send({
        error: `unsupported target chain ${body.targetChainId}`,
        code: 'CHAIN_UNSUPPORTED',
        supportedChains: externalChains().map((c) => c.chainId),
      });
    }

    // Cache lookup (freshness = ATTESTATION_CACHE_MS). Returns the
    // previously-signed attestation as long as it hasn't gone stale AND
    // hasn't already expired.
    const key = cacheKey({
      callerChainId: body.callerChainId,
      wallet,
      ourCollection,
      targetCollection,
      targetChainId: body.targetChainId,
      tierId: tierIdBig,
    });
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.cachedAt < ATTESTATION_CACHE_MS && Number(cached.expiry) * 1000 > now + 60_000) {
      return reply.send({
        count: cached.count.toString(),
        expiry: cached.expiry.toString(),
        sig: cached.sig,
        cached: true,
      });
    }

    // Read balanceOf on the target chain.
    let count: bigint;
    try {
      const client = clientFor(target);
      count = (await client.readContract({
        address: targetCollection,
        abi: balanceOfAbi,
        functionName: 'balanceOf',
        args: [wallet],
      })) as bigint;
    } catch (err) {
      app.log.error({ err, target: target.slug, targetCollection, wallet }, 'balanceOf read failed');
      return reply.code(502).send({
        error: 'external chain read failed',
        code: 'RPC_FAILURE',
      });
    }

    const expiry = BigInt(Math.floor((now + ATTESTATION_EXPIRY_MS) / 1000));

    // Sign the attestation. EIP-191 personal_sign envelope so we don't
    // need EIP-712 domain separators — everything the sig needs to be
    // unique lives in the hash inputs (chainid, ourCollection, tierId,
    // etc). Matches ECDSA.tryRecover(toEthSignedMessageHash(hash)) on
    // the mint module side.
    const hash = attestationHash({
      callerChainId: body.callerChainId,
      wallet,
      ourCollection,
      targetCollection,
      targetChainId: body.targetChainId,
      tierId: tierIdBig,
      count,
      expiry,
    });
    const sig = await signer.signMessage({ message: { raw: hash } });

    cache.set(key, { count, expiry, sig, cachedAt: now });

    // Opportunistic cache eviction — cap at ~1k entries to keep memory bounded.
    if (cache.size > 1024) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }

    return reply.send({
      count: count.toString(),
      expiry: expiry.toString(),
      sig,
      cached: false,
    });
  });

  // Health/config surface — useful for the frontend to know which
  // external chains it can offer as targets on the launch form.
  app.get('/api/nft-discount/config', async (_req, reply) => {
    return reply.send({
      supportedChains: externalChains().map((c) => ({ chainId: c.chainId, slug: c.slug })),
      signerReady: !!signer,
      signerAddress: signer?.address ?? null,
      cacheEntries: cache.size,
      expiryMs: ATTESTATION_EXPIRY_MS,
      cacheMs: ATTESTATION_CACHE_MS,
    });
  });
}
// toHex is imported but unused in this module today; keeping for the
// eventual on-chain event verification (recover-on-chain path) that
// consumers may add without re-editing imports. Silence lint:
void toHex;
