import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPublicClient, getAddress, http, isAddress, parseAbi, type Address, type Hex } from 'viem';

import { sql as _defaultSql } from '../db.ts';
import { AgentAccountDetector, defaultAccountChain, type AccountChain } from '../agentAccounts.ts';
import type { SqlLike } from './social.ts';
import {
  AGENT_CHAIN_ID,
  AGENT_LINK_DOMAIN,
  AGENT_LINK_MAX_TTL_SEC,
  AGENT_LINK_TYPES,
  ERC8004_IDENTITY_REGISTRY,
  cleanAgentName,
} from '../../../shared/agent-link.ts';

/// Agent links (docs/PLAN-agents-and-swarms.md 2.3): which wallets are AI agents,
/// and who owns them. Drives the Agent badge on the site and the agent API.
///
///   - POST /agents/link        owner-signed EIP-712 AgentLink (shared/agent-link.ts)
///   - GET  /agents?wallets=a,b  registered agents + agent Safes among up to 100 wallets
///
/// Write gate, all checked here (the web/MCP layer is not trusted):
///   1. the EIP-712 signature recovers to `owner` (EOA, or ERC-1271 for a Safe);
///   2. `expiry` is in the future and at most an hour out; `nonce` is new (replay);
///   3. on-chain, the ERC-8004 registry says `owner` owns agent #agentId AND its
///      registry wallet is `agentWallet` (so the agent wallet itself signed off,
///      through the registry's own setAgentWallet proof).
/// Reads re-check (3) for every row, cached briefly, so an agent NFT transfer or a
/// wallet change drops the badge (threat T4).

const registryAbi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
]);

const RECHECK_TTL_MS = 60_000;
const MAX_WALLETS = 100;

export interface AgentChain {
  /// Owner of the agent NFT, or null if it does not exist / RPC failed.
  ownerOf(agentId: bigint): Promise<Address | null>;
  agentWalletOf(agentId: bigint): Promise<Address | null>;
  verifyLink(args: { owner: Address; message: Record<string, unknown>; signature: Hex }): Promise<boolean>;
}

function defaultChain(): AgentChain {
  const client = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com') });
  return {
    async ownerOf(agentId) {
      try {
        return (await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: registryAbi, functionName: 'ownerOf', args: [agentId] })) as Address;
      } catch {
        return null;
      }
    },
    async agentWalletOf(agentId) {
      try {
        return (await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: registryAbi, functionName: 'getAgentWallet', args: [agentId] })) as Address;
      } catch {
        return null;
      }
    },
    async verifyLink({ owner, message, signature }) {
      try {
        // ERC-1271 aware: a Safe owner works as well as an EOA.
        return await client.verifyTypedData({ address: owner, domain: AGENT_LINK_DOMAIN, types: AGENT_LINK_TYPES, primaryType: 'AgentLink', message: message as never, signature });
      } catch {
        return false;
      }
    },
  };
}

const LinkBody = z
  .object({
    owner: z.string().refine(isAddress),
    agentWallet: z.string().refine(isAddress),
    agentId: z.string().regex(/^\d{1,30}$/),
    name: z.string().min(1).max(80),
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    expiry: z.number().int().positive(),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130,2000}$/),
  })
  .strict();

interface AgentRow {
  agentWallet: string;
  owner: string;
  agentId: string;
  registry: string;
  name: string | null;
  linkedAt: string;
}

export async function registerAgentRoutes(
  app: FastifyInstance,
  opts?: { sqlOverride?: SqlLike; chain?: AgentChain; accountChain?: AccountChain; now?: () => number },
): Promise<void> {
  const sql = (opts?.sqlOverride ?? _defaultSql) as SqlLike | null;
  const chain = opts?.chain ?? defaultChain();
  const now = opts?.now ?? Date.now;
  const detector = new AgentAccountDetector(opts?.accountChain ?? defaultAccountChain(), now);
  const recheck = new Map<string, { at: number; ok: boolean }>();

  async function stillValid(row: AgentRow): Promise<boolean> {
    const key = `${row.agentId}:${row.owner}:${row.agentWallet}`;
    const hit = recheck.get(key);
    if (hit && now() - hit.at < RECHECK_TTL_MS) return hit.ok;
    const id = BigInt(row.agentId);
    const [o, w] = await Promise.all([chain.ownerOf(id), chain.agentWalletOf(id)]);
    const ok = !!o && !!w && o.toLowerCase() === row.owner && w.toLowerCase() === row.agentWallet;
    if (recheck.size > 5_000) recheck.clear();
    recheck.set(key, { at: now(), ok });
    return ok;
  }

  app.post(
    '/agents/link',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!sql) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED', message: 'agent store unavailable' });
      const parsed = LinkBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY', message: 'invalid link body' });
      const b = parsed.data;
      const owner = getAddress(b.owner);
      const agentWallet = getAddress(b.agentWallet);
      if (owner === agentWallet) return reply.code(400).send({ code: 'SAME_WALLET', message: 'agent wallet must differ from the owner' });
      const name = cleanAgentName(b.name);
      // The signed name must already be clean: cleaning after verify would store
      // text the owner never signed.
      if (!name || name !== b.name) return reply.code(400).send({ code: 'BAD_NAME', message: 'name must be 1-40 printable characters' });
      const nowSec = Math.floor(now() / 1000);
      if (b.expiry <= nowSec) return reply.code(409).send({ code: 'EXPIRED', message: 'link message expired; sign a fresh one' });
      if (b.expiry > nowSec + AGENT_LINK_MAX_TTL_SEC) return reply.code(400).send({ code: 'EXPIRY_TOO_FAR', message: 'expiry may be at most one hour ahead' });

      const agentId = BigInt(b.agentId);
      const message = { owner, agentWallet, agentId, name, nonce: b.nonce as Hex, expiry: BigInt(b.expiry) };
      if (!(await chain.verifyLink({ owner, message, signature: b.signature as Hex }))) {
        return reply.code(401).send({ code: 'BAD_SIGNATURE', message: 'signature is not from the owner over this link' });
      }
      const [onOwner, onWallet] = await Promise.all([chain.ownerOf(agentId), chain.agentWalletOf(agentId)]);
      if (!onOwner) return reply.code(404).send({ code: 'NO_AGENT', message: `ERC-8004 agent #${agentId} not found` });
      if (onOwner.toLowerCase() !== owner.toLowerCase()) return reply.code(403).send({ code: 'NOT_OWNER', message: `agent #${agentId} is owned by ${onOwner}` });
      if (!onWallet || onWallet.toLowerCase() !== agentWallet.toLowerCase()) {
        return reply.code(409).send({ code: 'WALLET_NOT_SET', message: `agent #${agentId} registry wallet is ${onWallet ?? 'unset'}; run setAgentWallet first` });
      }

      // Replay guard: a nonce is accepted once, ever.
      const used = await sql`
        INSERT INTO app.agent_link_nonces (owner, nonce) VALUES (${owner.toLowerCase()}, ${b.nonce.toLowerCase()})
        ON CONFLICT DO NOTHING
        RETURNING nonce
      `;
      if (used.length === 0) return reply.code(409).send({ code: 'REPLAY', message: 'this link signature was already used' });

      const rows = await sql`
        INSERT INTO app.agents (agent_wallet, owner, agent_id, registry, chain_id, name, link_nonce, link_expiry, link_signature)
        VALUES (${agentWallet.toLowerCase()}, ${owner.toLowerCase()}, ${agentId.toString()}, ${ERC8004_IDENTITY_REGISTRY.toLowerCase()},
                ${AGENT_CHAIN_ID}, ${name}, ${b.nonce.toLowerCase()}, ${b.expiry}, ${b.signature})
        ON CONFLICT (agent_wallet) DO UPDATE SET
          owner = EXCLUDED.owner, agent_id = EXCLUDED.agent_id, registry = EXCLUDED.registry, name = EXCLUDED.name,
          link_nonce = EXCLUDED.link_nonce, link_expiry = EXCLUDED.link_expiry, link_signature = EXCLUDED.link_signature,
          linked_at = now()
        RETURNING agent_wallet AS "agentWallet", owner, agent_id AS "agentId", registry, name, linked_at AS "linkedAt"
      `;
      recheck.clear();
      return reply.send({ record: rows[0] });
    },
  );

  /// `agents`: badged agent wallets (owner-linked). `accounts`: agent Safes found
  /// on chain (agentAccounts.ts), anonymous. Either one gets the Agent tag.
  app.get<{ Querystring: { wallets?: string } }>(
    '/agents',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const wallets = [...new Set((req.query.wallets ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean))];
      if (wallets.length === 0) return reply.send({ agents: [], accounts: [] });
      if (wallets.length > MAX_WALLETS || wallets.some((w) => !isAddress(w))) {
        return reply.code(400).send({ code: 'BAD_WALLETS', message: `up to ${MAX_WALLETS} comma-separated addresses` });
      }
      const [rows, accounts] = await Promise.all([
        sql
          ? (sql`
              SELECT agent_wallet AS "agentWallet", owner, agent_id AS "agentId", registry, name, linked_at AS "linkedAt"
              FROM app.agents WHERE agent_wallet IN ${sql(wallets)}
            ` as unknown as Promise<AgentRow[]>)
          : Promise.resolve([] as AgentRow[]),
        detector.find(wallets),
      ]);
      const checked = await Promise.all(rows.map(async (r) => ((await stillValid(r)) ? r : null)));
      return reply.send({ agents: checked.filter((r): r is AgentRow => r !== null), accounts });
    },
  );
}
