/// NFT whitelist support (2026-10-09). Three endpoints:
///
///   POST /api/nft-wl/list            { wallets }            -> { root, count }
///     The create page saves a pasted wallet list before launch. Stored under
///     its merkle root, which the server recomputes itself, so a list can't be
///     saved under a root it doesn't produce (no auth needed).
///
///   GET  /api/nft-wl/proof/:root/:wallet                    -> { inList, proof }
///     The collection page asks for a minter's proof. Used for both whitelist
///     windows (NftWhitelistModule.walletListRoot) and wallet-list discount
///     tiers (DiscountTier.walletListRoot); both use the same leaf.
///
///   POST /api/nft-wl/attest          { wallet, whitelistModule } -> { count, expiry, sig }
///     Holder whitelists: reads the module's target collection, checks the
///     wallet's balance on that chain, and signs NftWhitelistModule's
///     URU_NFT_WL_V1 hash with the same key the module was launched with.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  isAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { sql } from '../db.ts';
import { MAX_WALLET_LIST_SIZE, buildWalletList, normalizeWallets, type WalletListTree } from '../nft-wallet-list.ts';
import { externalChains } from './nft-discount-attest.ts';

const LAUNCH_CHAIN_ID = 4663;

const ListBody = z.object({
  wallets: z.union([z.array(z.string()).max(MAX_WALLET_LIST_SIZE * 2), z.string().max(1_000_000)]),
});

const AttestBody = z.object({
  wallet: z.string().refine((s) => isAddress(s), { message: 'not an EVM address' }),
  whitelistModule: z.string().refine((s) => isAddress(s), { message: 'not an EVM address' }),
});

const WL_MODULE_ABI = [
  { type: 'function', name: 'flavor', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'holdersTarget', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'holdersTargetChainId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'holdersMinCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'wlWindowEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'attestationSigner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'ourCollection', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const BALANCE_OF_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const FLAVOR_HOLDERS = 1;
const ATTESTATION_EXPIRY_S = 15 * 60;

/// MUST match NftWhitelistModule._attestationHash byte for byte.
export function wlAttestationHash(i: {
  chainId: number;
  module: Address;
  ourCollection: Address;
  holdersTarget: Address;
  holdersTargetChainId: bigint;
  wallet: Address;
  count: bigint;
  expiry: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
        { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
      ],
      [
        'URU_NFT_WL_V1', BigInt(i.chainId), i.module, i.ourCollection, i.holdersTarget,
        i.holdersTargetChainId, i.wallet, i.count, i.expiry,
      ],
    ),
  );
}

// Built trees by root, so repeat proof lookups skip the DB and hashing.
const treeCache = new Map<string, WalletListTree>();
async function treeForRoot(root: string): Promise<WalletListTree | null> {
  const key = root.toLowerCase();
  const hit = treeCache.get(key);
  if (hit) return hit;
  if (!sql) return null;
  const rows = await sql<Array<{ wallets: string[] }>>`
    SELECT wallets FROM app.nft_wallet_lists WHERE root = ${key}
  `;
  if (!rows[0]) return null;
  const tree = buildWalletList(normalizeWallets(rows[0].wallets));
  treeCache.set(key, tree);
  if (treeCache.size > 256) {
    const oldest = treeCache.keys().next().value;
    if (oldest) treeCache.delete(oldest);
  }
  return tree;
}

const clients = new Map<number, PublicClient>();
function clientFor(chainId: number): PublicClient | null {
  const hit = clients.get(chainId);
  if (hit) return hit;
  const chain = externalChains().find((c) => c.chainId === chainId);
  if (!chain) return null;
  const c = createPublicClient({ transport: http(chain.rpcUrl) });
  clients.set(chainId, c);
  return c;
}

export async function registerNftWlRoutes(app: FastifyInstance): Promise<void> {
  if (sql) {
    await sql`CREATE SCHEMA IF NOT EXISTS app`;
    await sql`
      CREATE TABLE IF NOT EXISTS app.nft_wallet_lists (
        root       text        PRIMARY KEY,
        wallets    jsonb       NOT NULL,
        count      integer     NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  }

  const rawKey = process.env.KEEPER_PRIVATE_KEY;
  let signer: ReturnType<typeof privateKeyToAccount> | null = null;
  if (rawKey) {
    try {
      signer = privateKeyToAccount((rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex);
    } catch {
      app.log.warn('nft-wl: KEEPER_PRIVATE_KEY malformed; holder whitelist signing disabled');
    }
  }

  app.post('/api/nft-wl/list', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = ListBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY' });
    const wallets = normalizeWallets(parsed.data.wallets);
    if (wallets.length === 0) return reply.code(400).send({ code: 'NO_VALID_WALLETS' });
    if (wallets.length > MAX_WALLET_LIST_SIZE) {
      return reply.code(413).send({ code: 'TOO_MANY_WALLETS', max: MAX_WALLET_LIST_SIZE });
    }
    // Without storage, minters could never get proofs: refuse rather than let
    // a launch go out with a list nobody can use.
    if (!sql) return reply.code(503).send({ code: 'NO_STORAGE' });
    const tree = buildWalletList(wallets);
    const root = tree.root.toLowerCase();
    await sql`
      INSERT INTO app.nft_wallet_lists (root, wallets, count)
      VALUES (${root}, ${JSON.stringify(tree.wallets)}::jsonb, ${tree.wallets.length})
      ON CONFLICT (root) DO NOTHING
    `;
    treeCache.set(root, tree);
    return reply.send({ root: tree.root, count: tree.wallets.length });
  });

  app.get<{ Params: { root: string; wallet: string } }>(
    '/api/nft-wl/proof/:root/:wallet',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { root, wallet } = req.params;
      if (!/^0x[0-9a-fA-F]{64}$/.test(root) || !isAddress(wallet)) return reply.code(400).send({ code: 'BAD_PARAMS' });
      const tree = await treeForRoot(root);
      if (!tree) return reply.code(404).send({ code: 'LIST_NOT_FOUND' });
      const proof = tree.proofFor(wallet as Address);
      return reply.send({ root: tree.root, inList: proof !== null, proof: proof ?? [] });
    },
  );

  app.post('/api/nft-wl/attest', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!signer) return reply.code(503).send({ code: 'SIGNER_UNSET' });
    const parsed = AttestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY' });
    const wallet = parsed.data.wallet as Address;
    const module = parsed.data.whitelistModule as Address;
    const rh = clientFor(LAUNCH_CHAIN_ID);
    if (!rh) return reply.code(503).send({ code: 'NO_RPC' });

    let cfg: { flavor: number; target: Address; targetChainId: bigint; min: bigint; end: bigint; signer: Address; ours: Address };
    try {
      const [flavor, target, targetChainId, min, end, modSigner, ours] = await Promise.all(
        (['flavor', 'holdersTarget', 'holdersTargetChainId', 'holdersMinCount', 'wlWindowEnd', 'attestationSigner', 'ourCollection'] as const)
          .map((fn) => rh.readContract({ address: module, abi: WL_MODULE_ABI, functionName: fn })),
      );
      cfg = {
        flavor: Number(flavor), target: target as Address, targetChainId: targetChainId as bigint, min: min as bigint,
        end: end as bigint, signer: modSigner as Address, ours: ours as Address,
      };
    } catch {
      return reply.code(400).send({ code: 'NOT_A_WHITELIST_MODULE' });
    }
    if (cfg.flavor !== FLAVOR_HOLDERS) return reply.code(400).send({ code: 'NOT_HOLDERS_WHITELIST' });
    if (cfg.signer.toLowerCase() !== signer.address.toLowerCase()) return reply.code(409).send({ code: 'SIGNER_MISMATCH' });
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    if (nowS > cfg.end) return reply.send({ eligible: true, windowOver: true });

    const target = clientFor(Number(cfg.targetChainId));
    if (!target) return reply.code(400).send({ code: 'CHAIN_UNSUPPORTED', chainId: cfg.targetChainId.toString() });
    let count: bigint;
    try {
      count = (await target.readContract({ address: cfg.target, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [wallet] })) as bigint;
    } catch {
      return reply.code(502).send({ code: 'RPC_FAILURE' });
    }
    if (count < cfg.min) {
      return reply.send({ eligible: false, count: count.toString(), min: cfg.min.toString() });
    }
    // The module rejects a sig after its expiry; never past the window end either.
    let expiry = nowS + BigInt(ATTESTATION_EXPIRY_S);
    if (expiry > cfg.end) expiry = cfg.end;
    const hash = wlAttestationHash({
      chainId: LAUNCH_CHAIN_ID, module, ourCollection: cfg.ours, holdersTarget: cfg.target,
      holdersTargetChainId: cfg.targetChainId, wallet, count, expiry,
    });
    const sig = await signer.signMessage({ message: { raw: hash } });
    return reply.send({ eligible: true, count: count.toString(), expiry: expiry.toString(), sig });
  });
}
