/**
 * Transaction helper: write, wait, fail loudly on revert, log gas. Every
 * keeper tx goes through here so gas per action is visible in logs and the
 * fork tests can read it back.
 */
import type { Abi, Address, Hex, TransactionReceipt } from 'viem';
import type { PublicClient, WalletClient } from './clients.ts';

export interface Ctx {
  pc: PublicClient;
  wc: WalletClient;
  keeper: Address;
}

export interface GasRecord {
  label: string;
  gasUsed: bigint;
  hash: Hex;
}

/// Gas log, readable by tests (cleared by them between scenarios).
export const gasLog: GasRecord[] = [];

export async function send(
  ctx: Ctx,
  label: string,
  req: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint },
): Promise<TransactionReceipt> {
  const hash = await ctx.wc.writeContract({
    address: req.address,
    abi: req.abi as Abi,
    functionName: req.functionName,
    args: req.args as unknown[],
    value: req.value,
    account: ctx.wc.account!,
    chain: ctx.wc.chain,
  });
  const receipt = await ctx.pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`[keeper:tx] ${label} reverted (tx ${hash})`);
  gasLog.push({ label, gasUsed: receipt.gasUsed, hash });
  console.log(`[keeper:tx] ${label} ok gas=${receipt.gasUsed} tx=${hash}`);
  return receipt;
}

/// Raw call (e.g. Seaport fulfillment built from API data).
export async function sendRaw(ctx: Ctx, label: string, to: Address, data: Hex, value: bigint): Promise<TransactionReceipt> {
  const hash = await ctx.wc.sendTransaction({ to, data, value, account: ctx.wc.account!, chain: ctx.wc.chain });
  const receipt = await ctx.pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`[keeper:tx] ${label} reverted (tx ${hash})`);
  gasLog.push({ label, gasUsed: receipt.gasUsed, hash });
  console.log(`[keeper:tx] ${label} ok gas=${receipt.gasUsed} tx=${hash}`);
  return receipt;
}

export const gasCost = (r: TransactionReceipt): bigint => r.gasUsed * r.effectiveGasPrice;
