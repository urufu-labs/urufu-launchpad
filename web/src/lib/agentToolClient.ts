'use client';

/// Browser helpers for pages built on the v2 agent API (lib/agentV2): call a tool,
/// and send the unsigned txs it returns from the connected wallet, one at a time.
/// The API never holds keys; the wallet signs everything.

import { type Address, type Hex, type TransactionReceipt } from 'viem';
import { useChainId, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi';

export const ROBINHOOD_CHAIN_ID = 4663;

export interface ToolTx {
  step: number;
  purpose: string;
  to: Address;
  data: Hex;
  value: string;
  valueFormatted: string;
  summary: string;
}

export interface ToolResponse<T> {
  data: T;
  untrusted?: { fields: Record<string, { text: string | null }> };
}

export class ToolCallError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function callTool<T>(tool: string, input: Record<string, unknown>): Promise<ToolResponse<T>> {
  const res = await fetch(`/api/agent/v2/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body = (await res.json().catch(() => ({}))) as { data?: T; untrusted?: ToolResponse<T>['untrusted']; error?: { message?: string; code?: string } };
  if (!res.ok || !body.data) throw new ToolCallError(body.error?.message ?? `Request failed (${res.status})`, res.status, body.error?.code ?? 'ERROR');
  return { data: body.data, untrusted: body.untrusted };
}

/// Text of one untrusted field (written by a stranger: render as plain text only).
export const untrustedText = (r: { untrusted?: ToolResponse<unknown>['untrusted'] }, key: string): string =>
  r.untrusted?.fields[key]?.text ?? '';

export function walletErrorText(e: unknown): string {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return /rejected|denied/i.test(m) ? 'You cancelled it in your wallet.' : m;
}

/// Sends one tool tx from the connected wallet on Robinhood Chain and waits for it.
export function useToolTx() {
  const { sendTransactionAsync } = useSendTransaction();
  const client = usePublicClient({ chainId: ROBINHOOD_CHAIN_ID });
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  return async (tx: ToolTx): Promise<TransactionReceipt> => {
    if (chainId !== ROBINHOOD_CHAIN_ID) await switchChainAsync({ chainId: ROBINHOOD_CHAIN_ID });
    const hash = await sendTransactionAsync({ chainId: ROBINHOOD_CHAIN_ID, to: tx.to, data: tx.data, value: BigInt(tx.value) });
    const receipt = await client!.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The transaction failed on chain.');
    return receipt;
  };
}
