/**
 * Agent link: the EIP-712 message an owner wallet signs to say "I run agent
 * wallet X, registered as ERC-8004 agent #N". Shared by web (builds the message
 * for the owner to sign) and compile-service (verifies it before storing), so the
 * two can never disagree on the bytes. Plan: docs/PLAN-agents-and-swarms.md 2.3, T4/T5.
 *
 * Replay protection: the domain pins chain 4663 and the ERC-8004 registry as the
 * verifying contract, every link carries a random 32-byte nonce the store accepts
 * once, and `expiry` (unix seconds) is at most AGENT_LINK_MAX_TTL_SEC ahead.
 *
 * No imports: both packages load this file directly.
 */

export const AGENT_CHAIN_ID = 4663;

/// ERC-8004 Identity Registry (proxy) on Robinhood Chain, v2.0.0.
export const ERC8004_IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;

export const AGENT_LINK_MAX_TTL_SEC = 60 * 60;
export const AGENT_NAME_MAX = 40;

export const AGENT_LINK_DOMAIN = {
  name: 'urufu agent link',
  version: '1',
  chainId: AGENT_CHAIN_ID,
  verifyingContract: ERC8004_IDENTITY_REGISTRY,
} as const;

export const AGENT_LINK_TYPES = {
  AgentLink: [
    { name: 'owner', type: 'address' },
    { name: 'agentWallet', type: 'address' },
    { name: 'agentId', type: 'uint256' },
    { name: 'name', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

/// ERC-8004 `setAgentWallet` proof, signed by the AGENT wallet (registry v2.0.0:
/// EIP712("ERC8004IdentityRegistry", "1"), deadline at most 5 minutes ahead).
export const AGENT_WALLET_SET_DOMAIN = {
  name: 'ERC8004IdentityRegistry',
  version: '1',
  chainId: AGENT_CHAIN_ID,
  verifyingContract: ERC8004_IDENTITY_REGISTRY,
} as const;

export const AGENT_WALLET_SET_TYPES = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const AGENT_WALLET_MAX_DEADLINE_SEC = 5 * 60;

/// Display names: printable, trimmed, no control / bidi / zero-width characters.
export function cleanAgentName(raw: string): string | null {
  const t = raw.normalize('NFKC').trim();
  if (t.length === 0 || Array.from(t).length > AGENT_NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/.test(t)) return null;
  return t;
}
