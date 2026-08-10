/// POST /api/agent/verify
/// body: { txHash: string }
///
/// After the agent broadcasts the tx from /api/agent/quote, it POSTs the hash
/// here. We fetch the receipt, confirm the tx succeeded, pluck the token
/// address out of the `Launched` event, then look up the curve address so the
/// agent can report both back to the human without any log-parsing itself.

import { NextRequest, NextResponse } from 'next/server';
import type { Address, Hex } from 'viem';

import {
  AGENT_ADDRESSES,
  LAUNCHED_EVENT_TOPIC,
  agentPublicClient,
} from '@/lib/agentApi';
import { curveFactoryAbi } from '@/lib/abis';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { txHash?: string };
  try {
    body = await req.json() as { txHash?: string };
  } catch {
    return NextResponse.json({ error: 'body must be JSON with a `txHash` field' }, { status: 400 });
  }
  const txHash = body.txHash?.trim();
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: '`txHash` must be a 0x-prefixed 32-byte hex string' }, { status: 400 });
  }

  try {
    const client = agentPublicClient();
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });

    if (receipt.status !== 'success') {
      return NextResponse.json(
        {
          txHash,
          status: 'failed',
          note: 'tx reverted on chain. try /api/agent/quote again with the same params to see which preflight warning would have caught it.',
          blockNumber: receipt.blockNumber.toString(),
        },
        { status: 200 },
      );
    }

    /// The Router emits `Launched(address indexed token, address indexed
    /// launchedBy, uint8 indexed base, ...)`. Since the token address is
    /// topic1 (first indexed field), we can pluck it without decoding the
    /// full event data — a stable, ABI-independent read.
    const launchedLog = receipt.logs.find((log) =>
      log.topics[0] === LAUNCHED_EVENT_TOPIC
      && log.address.toLowerCase() === AGENT_ADDRESSES.Router.toLowerCase(),
    );
    if (!launchedLog || !launchedLog.topics[1] || !launchedLog.topics[2]) {
      return NextResponse.json(
        {
          txHash,
          status: 'success-but-no-launched-event',
          note: 'receipt is success but no Launched event from the Router. was this actually a launch tx?',
          blockNumber: receipt.blockNumber.toString(),
        },
        { status: 200 },
      );
    }

    const tokenAddress = `0x${launchedLog.topics[1]!.slice(-40)}` as Address;
    const launchedBy = `0x${launchedLog.topics[2]!.slice(-40)}` as Address;

    /// Curve is optional — a plain (non-installBondingCurve) launch has none.
    /// Quick launches always install one, but keep this defensive so the
    /// endpoint answers correctly for any launch tx.
    let curveAddress: Address | null = null;
    try {
      const curve = await client.readContract({
        address: AGENT_ADDRESSES.CurveFactory,
        abi: curveFactoryAbi,
        functionName: 'curveFor',
        args: [tokenAddress],
      });
      if (curve && curve !== '0x0000000000000000000000000000000000000000') curveAddress = curve as Address;
    } catch { /* CurveFactory read failure isn't fatal to the verify response */ }

    return NextResponse.json({
      txHash,
      status: 'success',
      token: {
        address: tokenAddress,
        launcher: launchedBy,
        curve: curveAddress,
      },
      block: {
        number: receipt.blockNumber.toString(),
        hash: receipt.blockHash,
      },
      gas: {
        used: receipt.gasUsed.toString(),
      },
      links: {
        blockscout: `https://robinhoodchain.blockscout.com/token/${tokenAddress}`,
        trade: `https://urufulabs.xyz/trade/${tokenAddress}`,
      },
      hints: {
        next: 'report the trade URL back to the human. if initialBuyEth was set, they already own tokens; curve balance sits at `curve.tokenReserve()` until graduation.',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'verify failed' }, { status: 500 });
  }
}
