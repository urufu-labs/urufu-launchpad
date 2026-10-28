'use client';

/// Agent tag: marks AI agents wherever a wallet shows up (trades, holders,
/// launchers, feed). Two kinds, both from one batched compile-service lookup:
///  - agent accounts: Safes run by an agent under an on-chain Roles policy
///    (docs/PLAN-agents-and-swarms.md 2.4). Anonymous, no owner.
///  - badged agent wallets: ERC-8004 + owner-signed link (2.3). The owner chose
///    to be shown, so the profile page can name them.
/// Every tag links to the agent's page, /agent/<address>.

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

import { fetchAgents, type RemoteAgent } from '@/lib/socialApi';

export interface AgentInfo {
  kind: 'account' | 'badged';
  /// Set for badged wallets only.
  badge: RemoteAgent | null;
}

/// Map of lower-cased wallet -> agent info for every agent among `wallets`.
export function useAgentTags(wallets: string[]): Map<string, AgentInfo> {
  const key = [...new Set(wallets.filter(Boolean).map((w) => w.toLowerCase()))].sort().slice(0, 100);
  const q = useQuery({
    queryKey: ['agents', key.join(',')],
    queryFn: () => fetchAgents(key),
    enabled: key.length > 0,
    staleTime: 60_000,
  });
  const m = new Map<string, AgentInfo>();
  for (const a of q.data?.accounts ?? []) m.set(a.address.toLowerCase(), { kind: 'account', badge: null });
  for (const a of q.data?.agents ?? []) m.set(a.agentWallet.toLowerCase(), { kind: 'badged', badge: a });
  return m;
}

/// Small "Agent" pill linking to the agent's page. Pass `asText` inside another
/// link (a nested <a> is invalid HTML).
export function AgentTag({ address, info, asText = false }: { address: string; info: AgentInfo | undefined; asText?: boolean }) {
  if (!info) return null;
  const name = info.badge?.name;
  const title = `AI agent${name ? ` "${name}"` : ''}. See what it does.`;
  if (asText) {
    return <span className="ui-badge" data-tone="info" title="AI agent">Agent</span>;
  }
  return (
    <Link href={`/agent/${address}`} className="ui-badge" data-tone="info" title={title} style={{ textDecoration: 'none' }}>
      Agent
    </Link>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/// Badge for a badged agent wallet, optionally naming the owner who signed for it.
export function AgentBadge({ agent, showOwner = false }: { agent: RemoteAgent; showOwner?: boolean }) {
  const title = `AI agent${agent.name ? ` "${agent.name}"` : ''}, run by ${agent.owner}`;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Link href={`/agent/${agent.agentWallet}`} className="ui-badge" data-tone="info" title={title} style={{ textDecoration: 'none' }}>Agent</Link>
      {showOwner && (
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          run by <Link href={`/profile/${agent.owner}`}>{short(agent.owner)}</Link>
        </span>
      )}
    </span>
  );
}
