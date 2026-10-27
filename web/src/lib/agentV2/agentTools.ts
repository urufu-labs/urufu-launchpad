/// Phase 1b agent identity tools: register an agent in the ERC-8004 Identity
/// Registry and link it to its owner, and look agents up (the Agent badge).
///
/// Registration is five small steps, each one call to `register_agent` with
/// a `step`, because three different signatures are involved and we never hold a key:
///
///   1. register        owner wallet sends registry.register(agentURI) -> agent #N
///   2. wallet_message  the AGENT wallet signs the registry's AgentWalletSet message
///   3. set_wallet      owner wallet sends registry.setAgentWallet(N, agent, deadline, sig)
///   4. link_message    the OWNER wallet signs urufu's AgentLink message
///   5. link            urufu stores the link; the badge shows from then on
///
/// The registry is upgradeable by its maintainers, so the owner's own signed link
/// is a second, independent check (threat T4). The store re-checks both on read.

import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from 'viem';

import {
  AGENT_LINK_DOMAIN,
  AGENT_LINK_MAX_TTL_SEC,
  AGENT_LINK_TYPES,
  AGENT_WALLET_MAX_DEADLINE_SEC,
  AGENT_WALLET_SET_DOMAIN,
  AGENT_WALLET_SET_TYPES,
  cleanAgentName,
} from '../../../../shared/agent-link';
import { addressField } from './schema';
import { MINUTE, simulate, ToolError, txOut, type AgentDeps, type ToolDef, type ToolOutput } from './tools';
import { untrustedBlock } from './untrusted';

export const identityRegistryAbi = parseAbi([
  'function register() returns (uint256 agentId)',
  'function register(string agentURI) returns (uint256 agentId)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

type Step = 'register' | 'wallet_message' | 'set_wallet' | 'link_message' | 'link';

interface RegisterInput {
  step: Step;
  owner: string;
  agentWallet: string;
  agentId?: string;
  agentURI?: string;
  name?: string;
  deadline?: number;
  nonce?: string;
  expiry?: number;
  signature?: string;
}

const STEPS: Step[] = ['register', 'wallet_message', 'set_wallet', 'link_message', 'link'];

function need<T>(v: T | undefined, field: string, step: Step): T {
  if (v === undefined) throw new ToolError('INVALID_INPUT', `step "${step}" needs \`${field}\``);
  return v;
}

const nowSec = (deps: AgentDeps) => Math.floor(deps.now() / 1000);

async function ownerOf(deps: AgentDeps, agentId: bigint): Promise<Address> {
  try {
    return (await deps.client.readContract({ address: deps.book.Erc8004IdentityRegistry, abi: identityRegistryAbi, functionName: 'ownerOf', args: [agentId] })) as Address;
  } catch {
    throw new ToolError('NOT_FOUND', `ERC-8004 agent #${agentId} does not exist (yet). Wait for the register tx to confirm.`, 404);
  }
}

/// bigint -> string so typed data survives JSON; wallets accept numeric strings.
function typedDataJson(t: { domain: object; types: object; primaryType: string; message: Record<string, unknown> }) {
  return { ...t, message: Object.fromEntries(Object.entries(t.message).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) };
}

export const registerAgentTool: ToolDef<RegisterInput> = {
  name: 'register_agent',
  title: 'Register an agent (step by step)',
  description:
    'Register an AI agent wallet on Robinhood Chain (ERC-8004 Identity Registry) and link it to its owner so urufu shows an Agent badge on it. Five steps, in order: ' +
    '"register" (owner sends the register tx), "wallet_message" (agent wallet signs), "set_wallet" (owner sends setAgentWallet), "link_message" (owner signs the urufu link), "link" (urufu stores it). ' +
    'Each step returns what to sign or send next. Signatures are produced by the wallets themselves; never send a key.',
  inputSchema: {
    type: 'object',
    properties: {
      step: { type: 'string', enum: STEPS, description: 'Which step to run' },
      owner: addressField('Owner wallet (a person or their Safe). Owns the ERC-8004 agent NFT.'),
      agentWallet: addressField('The wallet the agent trades from. Must differ from the owner.'),
      agentId: { type: 'string', pattern: '^\\d{1,30}$', description: 'ERC-8004 agent id from step 1 (verify_tx shows it)' },
      agentURI: { type: 'string', maxLength: 300, pattern: '^(https://|ipfs://)[^\\s]+$', description: 'Step 1, optional: https:// or ipfs:// link to the agent card JSON' },
      name: { type: 'string', minLength: 1, maxLength: 40, description: 'Steps 4-5: display name for the badge' },
      deadline: { type: 'integer', minimum: 0, maximum: 99_999_999_999, description: 'Step 3: the deadline from step 2' },
      nonce: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', description: 'Step 5: the nonce from step 4' },
      expiry: { type: 'integer', minimum: 0, maximum: 99_999_999_999, description: 'Step 5: the expiry from step 4' },
      signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130,2000}$', description: 'Step 3: the agent wallet\'s signature. Step 5: the owner\'s signature.' },
    },
    required: ['step', 'owner', 'agentWallet'],
    additionalProperties: false,
  },
  rate: { limit: 20, windowMs: MINUTE },
  cacheTtlMs: 0,
  async handler(deps, input) {
    const owner = getAddress(input.owner);
    const agentWallet = getAddress(input.agentWallet);
    if (owner === agentWallet) {
      throw new ToolError('INVALID_INPUT', 'The agent wallet must be a different wallet from the owner, so the badge marks only what the agent does.');
    }
    const registry = deps.book.Erc8004IdentityRegistry;
    const step = input.step;

    if (step === 'register') {
      const data = input.agentURI
        ? encodeFunctionData({ abi: identityRegistryAbi, functionName: 'register', args: [input.agentURI] })
        : encodeFunctionData({ abi: identityRegistryAbi, functionName: 'register', args: [] });
      const tx = { to: registry, data, value: 0n };
      let predictedAgentId: string | null = null;
      try {
        const res = await deps.client.call({ account: owner, to: registry, data });
        if (res.data) predictedAgentId = (decodeFunctionResult({ abi: identityRegistryAbi, functionName: 'register', data: res.data }) as bigint).toString();
      } catch { /* informational only */ }
      return out({
        step, owner, agentWallet,
        transactions: [txOut(tx, 1, 'register', `Register a new ERC-8004 agent owned by ${owner}. Send from ${owner}.`)],
        predictedAgentId,
        next: 'Send this from the owner wallet. When it confirms, call verify_tx with the hash to read the agent id, then register_agent with step "wallet_message".',
      });
    }

    const agentId = BigInt(need(input.agentId, 'agentId', step));
    const currentOwner = await ownerOf(deps, agentId);
    if (currentOwner.toLowerCase() !== owner.toLowerCase()) {
      throw new ToolError('NOT_OWNER', `Agent #${agentId} is owned by ${currentOwner}, not ${owner}.`, 403);
    }

    if (step === 'wallet_message') {
      const deadline = BigInt(nowSec(deps) + AGENT_WALLET_MAX_DEADLINE_SEC - 60);
      const typedData = { domain: AGENT_WALLET_SET_DOMAIN, types: AGENT_WALLET_SET_TYPES, primaryType: 'AgentWalletSet', message: { agentId, newWallet: agentWallet, owner, deadline } };
      return out({
        step, owner, agentWallet, agentId: agentId.toString(), deadline: Number(deadline),
        signWith: agentWallet,
        typedData: typedDataJson(typedData),
        next: `Sign typedData with the AGENT wallet (${agentWallet}) using eth_signTypedData_v4, within 4 minutes. Then call register_agent with step "set_wallet", deadline ${deadline}, and the signature.`,
      });
    }

    if (step === 'set_wallet') {
      const deadline = BigInt(need(input.deadline, 'deadline', step));
      const signature = need(input.signature, 'signature', step) as Hex;
      const now = BigInt(nowSec(deps));
      if (deadline <= now) throw new ToolError('EXPIRED', 'The deadline has passed. Run step "wallet_message" again for a fresh message.', 409);
      if (deadline > now + BigInt(AGENT_WALLET_MAX_DEADLINE_SEC)) throw new ToolError('INVALID_INPUT', 'The deadline is more than 5 minutes ahead; the registry would refuse it.');
      const valid = await deps.client
        .verifyTypedData({ address: agentWallet, domain: AGENT_WALLET_SET_DOMAIN, types: AGENT_WALLET_SET_TYPES, primaryType: 'AgentWalletSet', message: { agentId, newWallet: agentWallet, owner, deadline }, signature })
        .catch(() => false);
      if (!valid) throw new ToolError('BAD_SIGNATURE', `The signature is not from the agent wallet ${agentWallet} over this agent id, owner and deadline.`, 400);
      const tx = { to: registry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: 'setAgentWallet', args: [agentId, agentWallet, deadline, signature] }), value: 0n };
      const simulation = await simulate(deps.client, owner, tx);
      return out({
        step, owner, agentWallet, agentId: agentId.toString(),
        transactions: [txOut(tx, 1, 'setAgentWallet', `Set ${agentWallet} as the wallet of agent #${agentId}. Send from ${owner} before the deadline.`)],
        simulation,
        errors: simulation.ok ? [] : [`Simulation reverted: ${simulation.error}`],
        next: 'Send this from the owner wallet. When it confirms, call register_agent with step "link_message".',
      });
    }

    // link_message / link: the registry must already point at the agent wallet.
    const onChainWallet = (await deps.client.readContract({ address: registry, abi: identityRegistryAbi, functionName: 'getAgentWallet', args: [agentId] }).catch(() => null)) as Address | null;
    if (!onChainWallet || onChainWallet.toLowerCase() !== agentWallet.toLowerCase()) {
      throw new ToolError('WALLET_NOT_SET', `Agent #${agentId}'s registry wallet is ${onChainWallet ?? 'unset'}, not ${agentWallet}. Finish steps "wallet_message" and "set_wallet" first.`, 409);
    }
    const name = cleanAgentName(need(input.name, 'name', step));
    if (!name) throw new ToolError('INVALID_INPUT', 'name must be 1-40 printable characters');

    if (step === 'link_message') {
      const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
      const nonce = `0x${[...nonceBytes].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
      const expiry = BigInt(nowSec(deps) + AGENT_LINK_MAX_TTL_SEC - 60);
      const typedData = { domain: AGENT_LINK_DOMAIN, types: AGENT_LINK_TYPES, primaryType: 'AgentLink', message: { owner, agentWallet, agentId, name, nonce, expiry } };
      return out({
        step, owner, agentWallet, agentId: agentId.toString(), name, nonce, expiry: Number(expiry),
        signWith: owner,
        typedData: typedDataJson(typedData),
        next: `Sign typedData with the OWNER wallet (${owner}) using eth_signTypedData_v4. Then call register_agent with step "link" and the same name, nonce, expiry and the signature.`,
      });
    }

    // step === 'link'
    const nonce = need(input.nonce, 'nonce', step) as Hex;
    const expiry = need(input.expiry, 'expiry', step);
    const signature = need(input.signature, 'signature', step) as Hex;
    if (expiry <= nowSec(deps)) throw new ToolError('EXPIRED', 'The link message expired. Run step "link_message" again.', 409);
    const res = await deps.agents.link({ owner, agentWallet, agentId: agentId.toString(), name, nonce, expiry, signature });
    if (!res.ok) throw new ToolError(res.code, res.message, res.status);
    return {
      data: {
        step, linked: true, agentWallet: res.record.agentWallet, owner: res.record.owner, agentId: res.record.agentId, registry: res.record.registry, linkedAt: res.record.linkedAt,
        next: 'Done. urufu now shows an Agent badge on this wallet, linked to its owner. Transferring the agent NFT or changing its registry wallet removes the badge.',
      },
      untrusted: untrustedBlock({ name: res.record.name }, { name: 'name' }),
    };
  },
};

interface GetAgentInput { wallet: string }

export const getAgentTool: ToolDef<GetAgentInput> = {
  name: 'get_agent',
  title: 'Is this wallet an agent?',
  description: 'Look up whether a wallet is a registered agent (ERC-8004 + owner link, re-checked on-chain), and who owns it.',
  inputSchema: {
    type: 'object',
    properties: { wallet: addressField('Wallet to check') },
    required: ['wallet'],
    additionalProperties: false,
  },
  rate: { limit: 60, windowMs: MINUTE },
  cacheTtlMs: 15_000,
  async handler(deps, input) {
    const wallet = getAddress(input.wallet);
    const rows = await deps.agents.byWallets([wallet]);
    if (rows === null) throw new ToolError('UPSTREAM', 'The agent registry store did not answer. Try again shortly.', 502);
    const r = rows.find((x) => x.agentWallet.toLowerCase() === wallet.toLowerCase());
    if (!r) return { data: { wallet, isAgent: false } };
    return {
      data: { wallet, isAgent: true, owner: r.owner, agentId: r.agentId, registry: r.registry, linkedAt: r.linkedAt },
      untrusted: untrustedBlock({ name: r.name }, { name: 'name' }),
    };
  },
};

function out(data: Record<string, unknown>): ToolOutput {
  return { data: { chainId: 4663, ...data } };
}


export const agentIdentityTools = [registerAgentTool, getAgentTool] as unknown as ReadonlyArray<ToolDef<never>>;
