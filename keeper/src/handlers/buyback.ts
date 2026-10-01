/**
 * BuybackURU and BuyAllowedToken.
 *
 * BuybackURU: every launch token the keeper holds for this launch -> URU
 * (direct on URU-paired pools, via ETH + URU/WETH for ETH-paired), then the
 * URU goes to cfg.uruBuybackSink (default 0x…dEaD, i.e. buy and burn).
 *
 * BuyAllowedToken: same, but the output is the launch's on-chain
 * taxTarget, delivered to the launcher (token owner) unless overridden.
 * The Dn404TaxAllowlist currently allows only URU; any other target needs
 * a known pool route and fails loudly until one is configured.
 */
import type { Address } from 'viem';
import { erc20Abi } from '../abis.ts';
import type { KeeperConfig } from '../config.ts';
import { tokenToPair, tokenToUru, type LaunchRef } from '../routes.ts';
import type { LaunchSnapshot } from '../sweeper.ts';
import { send, type Ctx } from '../tx.ts';

async function deliver(ctx: Ctx, token: Address, to: Address, amount: bigint, label: string) {
  if (amount === 0n) return;
  await send(ctx, label, { address: token, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
}

export async function handleBuybackUru(ctx: Ctx, cfg: KeeperConfig, s: LaunchSnapshot, balance: bigint): Promise<void> {
  const l: LaunchRef = { base: s.launch.base, pair: s.launch.pair };
  const r = await tokenToUru(ctx, cfg, l, balance);
  console.log(`[keeper:buybackUru] ${l.base} sold ${r.amountIn} tokens for ${r.amountOut} URU`);
  await deliver(ctx, cfg.uru, cfg.uruBuybackSink, r.amountOut, `URU buyback -> sink ${cfg.uruBuybackSink}`);
}

export async function handleBuyAllowedToken(ctx: Ctx, cfg: KeeperConfig, s: LaunchSnapshot, balance: bigint): Promise<void> {
  const l: LaunchRef = { base: s.launch.base, pair: s.launch.pair };
  const target = s.taxTarget;
  const recipient = cfg.buyAllowedRecipients.get(l.base.toLowerCase()) ?? s.owner;
  let out: bigint;
  if (target.toLowerCase() === cfg.uru.toLowerCase()) {
    out = (await tokenToUru(ctx, cfg, l, balance)).amountOut;
  } else if (target.toLowerCase() === l.pair.toLowerCase()) {
    out = (await tokenToPair(ctx, cfg, l, balance)).amountOut;
  } else {
    throw new Error(`[keeper:buyAllowedToken] no route to target ${target}; add a pool route before allowlisting it`);
  }
  console.log(`[keeper:buyAllowedToken] ${l.base} -> ${out} of ${target} for ${recipient}`);
  await deliver(ctx, target, recipient, out, `deliver ${target} -> ${recipient}`);
}
