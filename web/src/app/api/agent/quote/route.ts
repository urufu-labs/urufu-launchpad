/// GET /api/agent/quote?name=X&ticker=Y&launcher=0x...&initialBuyEth=Z
///
/// The heavy-lift endpoint. Given a launcher wallet + the two things an agent
/// asks its human ("what should the token be called?" and "should the launcher
/// buy some upfront?"), this returns EVERYTHING the agent needs to broadcast:
///
///   - `entrypoint`: which Router function to call (`launch` or `launchAndBuy`)
///   - `calldata`:   the fully-encoded transaction data (ready for eth_sendTransaction)
///   - `to`:         Router address
///   - `value`:      exact msg.value (fee + initialBuyEth, discount-adjusted)
///   - `fee`:        the fee slice alone, for display
///   - `warnings`:   preflight problems that would revert on chain
///
/// The agent NEVER hashes anything, never encodes anything, never picks between
/// entrypoints itself — this endpoint is the boundary between "agent knows
/// what the human asked" and "on-chain call ready to sign".

import { NextRequest, NextResponse } from 'next/server';
import { encodeFunctionData, formatEther, isAddress, parseEther, type Address } from 'viem';

import {
  AGENT_ADDRESSES,
  buildQuickLaunchParams,
  agentPublicClient,
} from '@/lib/agentApi';
import { routerAbi, nameRegistryAbi } from '@/lib/abis';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name')?.trim() ?? '';
  const ticker = req.nextUrl.searchParams.get('ticker')?.trim() ?? '';
  const launcher = req.nextUrl.searchParams.get('launcher')?.trim() ?? '';
  const initialBuyEthRaw = req.nextUrl.searchParams.get('initialBuyEth')?.trim() ?? '0';

  if (!name || !ticker) {
    return NextResponse.json(
      { error: 'both `name` and `ticker` query params are required' },
      { status: 400 },
    );
  }
  if (!isAddress(launcher)) {
    return NextResponse.json(
      { error: '`launcher` must be a valid 0x address (the wallet that will sign + pay the launch fee)' },
      { status: 400 },
    );
  }

  let initialBuyWei: bigint;
  try {
    initialBuyWei = parseEther(initialBuyEthRaw);
  } catch {
    return NextResponse.json(
      { error: '`initialBuyEth` must be a decimal ETH string (e.g. "0.01") or "0"' },
      { status: 400 },
    );
  }
  if (initialBuyWei < 0n) {
    return NextResponse.json({ error: '`initialBuyEth` must be >= 0' }, { status: 400 });
  }

  const params = buildQuickLaunchParams(name, ticker);
  const client = agentPublicClient();

  try {
    /// Discount-adjusted quote is what Router will actually charge. Also run
    /// the name+ticker validation in parallel — a doomed launch shouldn't
    /// return calldata that will just revert.
    const [fee, nameCheck, tickerCheck, paused, launcherBalance] = await Promise.all([
      client.readContract({
        address: AGENT_ADDRESSES.Router,
        abi: routerAbi,
        functionName: 'quoteFor',
        args: [params, launcher as Address],
      }),
      client.readContract({
        address: AGENT_ADDRESSES.NameRegistry,
        abi: nameRegistryAbi,
        functionName: 'validateName',
        args: [name],
      }),
      client.readContract({
        address: AGENT_ADDRESSES.NameRegistry,
        abi: nameRegistryAbi,
        functionName: 'validateTicker',
        args: [ticker],
      }),
      client.readContract({ address: AGENT_ADDRESSES.Router, abi: routerAbi, functionName: 'paused' }),
      client.getBalance({ address: launcher as Address }),
    ]);

    const totalValue = fee + initialBuyWei;
    /// Two-tier signal: `errors` are hard blockers (tx will revert or wallet
    /// lacks funds); `warnings` are informational (agent should surface but not
    /// abort). `canBroadcast = errors.length === 0` so the agent has a single
    /// bool to gate on.
    const errors: string[] = [];
    const warnings: string[] = [];
    if (paused) errors.push('Router is currently paused — this tx will revert with Router__Paused. Wait for owner to setPaused(false).');
    const [nameValid] = nameCheck as readonly [boolean, number];
    const [tickerValid] = tickerCheck as readonly [boolean, number];
    if (!nameValid) errors.push(`Name "${name}" fails NameRegistry.validateName — tx will revert. Try /api/agent/name-check for the specific reason.`);
    if (!tickerValid) errors.push(`Ticker "${ticker}" fails NameRegistry.validateTicker — tx will revert.`);
    if (launcherBalance < totalValue) {
      errors.push(`Launcher ${launcher} has ${formatEther(launcherBalance)} ETH but needs at least ${formatEther(totalValue)} ETH (fee + initialBuy). Gas is extra.`);
    }
    if (!LAUNCHPAD_LIVE) {
      warnings.push('LAUNCHPAD_LIVE is false — the launch will succeed on chain but the token will not appear in the site feed until the flag flips.');
    }

    /// Pick the entrypoint from initialBuyEth. Zero-buy uses plain `launch`;
    /// non-zero uses `launchAndBuy` so the launcher's first buy is atomic
    /// with the launch (prevents sniper-frontrun of the very first swap).
    const entrypoint = initialBuyWei > 0n ? 'launchAndBuy' : 'launch';
    const calldata = initialBuyWei > 0n
      ? encodeFunctionData({
        abi: routerAbi,
        functionName: 'launchAndBuy',
        args: [params, initialBuyWei, 0n, launcher as Address],
      })
      : encodeFunctionData({
        abi: routerAbi,
        functionName: 'launch',
        args: [params],
      });

    return NextResponse.json({
      launcher,
      name,
      ticker,
      entrypoint,
      to: AGENT_ADDRESSES.Router,
      calldata,
      value: totalValue.toString(),
      valueFormatted: `${formatEther(totalValue)} ETH`,
      fee: fee.toString(),
      feeFormatted: `${formatEther(fee)} ETH`,
      initialBuy: initialBuyWei.toString(),
      initialBuyFormatted: `${formatEther(initialBuyWei)} ETH`,
      errors,
      warnings,
      canBroadcast: errors.length === 0,
      params: {
        base: params.base,
        name: params.name,
        ticker: params.ticker,
        configHash: params.configHash,
        moduleCount: params.moduleCount.toString(),
        installBondingCurve: params.installBondingCurve,
        ownership: 'Renounce',
        antiSniperBlocks: params.antiSniperBlocks,
        antiSniperSeconds: params.antiSniperBlocks * 12,
        buybackBurnBps: params.buybackBurnBps,
      },
      hints: {
        next: 'sign + broadcast this calldata with the launcher wallet, then POST the txHash to /api/agent/verify to get the deployed token address.',
        gas: 'RH is L2 — gas is fractions of a cent. Any reasonable gasLimit above ~1.5M works for launchAndBuy; ~1M for plain launch.',
        confirmWithHuman: 'AGENT: confirm the token name, ticker, initialBuyEth, AND total ETH cost with the human before broadcasting. Never launch autonomously.',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'quote read failed' }, { status: 500 });
  }
}
