/// GET /api/agent/status
///
/// One-shot preflight for any AI agent: what chain are we on, is the router
/// paused, what are the fees, is the launchpad live for humans (which affects
/// whether an agent-launched token will surface in the UI), where are the
/// live V9 contracts. Everything an agent needs before it constructs its
/// first launch call.

import { NextResponse } from 'next/server';
import { formatEther } from 'viem';

import {
  AGENT_ADDRESSES,
  AGENT_CHAIN_ID,
  QUICK_ANTI_SNIPER_BLOCKS,
  QUICK_CONFIG_HASH,
  QUICK_CURVE_SUPPLY,
  agentPublicClient,
} from '@/lib/agentApi';
import { routerAbi, curveFactoryAbi } from '@/lib/abis';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const client = agentPublicClient();

    /// Batch every read into a single multicall so the endpoint returns in one
    /// RPC round-trip. Router.paused + fee shape + curve defaults + block number.
    const [
      paused,
      erc20Fee,
      moduleAddOn,
      hookAddOn,
      governanceAddOn,
      defaultCurveSupply,
      defaultVirtualTokenReserve,
      defaultVirtualEthReserve,
      defaultGraduationTargetEth,
      defaultTradeFeeBps,
      blockNumber,
    ] = await Promise.all([
      client.readContract({ address: AGENT_ADDRESSES.Router, abi: routerAbi, functionName: 'paused' }),
      client.readContract({ address: AGENT_ADDRESSES.Router, abi: routerAbi, functionName: 'fees', args: [0] }),
      client.readContract({ address: AGENT_ADDRESSES.Router, abi: routerAbi, functionName: 'moduleAddOnFee' }),
      client.readContract({ address: AGENT_ADDRESSES.Router, abi: routerAbi, functionName: 'hookAddOnFee' }),
      client.readContract({ address: AGENT_ADDRESSES.Router, abi: routerAbi, functionName: 'governanceAddOnFee' }),
      client.readContract({ address: AGENT_ADDRESSES.CurveFactory, abi: curveFactoryAbi, functionName: 'defaultCurveSupply' }),
      client.readContract({ address: AGENT_ADDRESSES.CurveFactory, abi: curveFactoryAbi, functionName: 'defaultVirtualTokenReserve' }),
      client.readContract({ address: AGENT_ADDRESSES.CurveFactory, abi: curveFactoryAbi, functionName: 'defaultVirtualEthReserve' }),
      client.readContract({ address: AGENT_ADDRESSES.CurveFactory, abi: curveFactoryAbi, functionName: 'defaultGraduationTargetEth' }),
      client.readContract({ address: AGENT_ADDRESSES.CurveFactory, abi: curveFactoryAbi, functionName: 'defaultTradeFeeBps' }),
      client.getBlockNumber(),
    ]);

    return NextResponse.json({
      chain: {
        id: AGENT_CHAIN_ID,
        name: 'Robinhood Chain',
        currentBlock: blockNumber.toString(),
        secPerL1Block: 12,
      },
      launchpad: {
        live: LAUNCHPAD_LIVE,
        paused,
        note: !LAUNCHPAD_LIVE
          ? 'human-facing UI is dark. agent-launched tokens still work on-chain but do not surface in the site feed until LAUNCHPAD_LIVE flips.'
          : 'launchpad is live for humans.',
      },
      fees: {
        erc20: erc20Fee.toString(),
        erc20Formatted: `${formatEther(erc20Fee)} ETH`,
        moduleAddOn: moduleAddOn.toString(),
        hookAddOn: hookAddOn.toString(),
        governanceAddOn: governanceAddOn.toString(),
        note: 'use /api/agent/quote?launcher=0x... for the discount-adjusted number an actual launcher pays.',
      },
      curve: {
        defaultSupply: defaultCurveSupply.toString(),
        virtualTokenReserve: defaultVirtualTokenReserve.toString(),
        virtualEthReserve: defaultVirtualEthReserve.toString(),
        graduationTargetEth: defaultGraduationTargetEth.toString(),
        graduationTargetEthFormatted: `${formatEther(defaultGraduationTargetEth)} ETH`,
        tradeFeeBps: Number(defaultTradeFeeBps),
      },
      quickLaunchDefaults: {
        configHash: QUICK_CONFIG_HASH,
        curveSupply: QUICK_CURVE_SUPPLY.toString(),
        antiSniperBlocks: QUICK_ANTI_SNIPER_BLOCKS,
        antiSniperSecondsApprox: QUICK_ANTI_SNIPER_BLOCKS * 12,
        buybackBurnBps: 0,
        ownership: 'Renounce',
      },
      addresses: AGENT_ADDRESSES,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'status read failed' }, { status: 500 });
  }
}
