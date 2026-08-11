/// GET /api/agent/name-check?name=X&ticker=Y
///
/// Answers "will Router.launch revert on Reserved / NameTaken / TickerTaken /
/// bad chars for this name+ticker?" without the agent needing to hash things
/// or parse revert selectors. NameRegistry exposes validateName / validateTicker
/// as pure view functions that mirror the exact rules the on-chain reserve
/// path enforces — we just proxy them.

import { NextRequest, NextResponse } from 'next/server';

import { AGENT_ADDRESSES, agentPublicClient } from '@/lib/agentApi';
import { nameRegistryAbi } from '@/lib/abis';

export const runtime = 'nodejs';

/// Matches Solidity's enum. Kept in sync manually because agents get a
/// friendlier string than a raw index.
const REASON_LABELS = ['Ok', 'InvalidCharacter', 'TooShort', 'TooLong', 'AlreadyTaken', 'Reserved'] as const;

function reasonLabel(index: number): string {
  return REASON_LABELS[index] ?? `Unknown(${index})`;
}

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name')?.trim() ?? '';
  const ticker = req.nextUrl.searchParams.get('ticker')?.trim() ?? '';

  if (!name || !ticker) {
    return NextResponse.json(
      { error: 'both `name` and `ticker` query params are required' },
      { status: 400 },
    );
  }

  try {
    const client = agentPublicClient();
    const [nameCheck, tickerCheck] = await Promise.all([
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
    ]);

    const [nameValid, nameReason] = nameCheck as readonly [boolean, number];
    const [tickerValid, tickerReason] = tickerCheck as readonly [boolean, number];

    return NextResponse.json({
      name: { input: name, available: nameValid, reason: reasonLabel(Number(nameReason)) },
      ticker: { input: ticker, available: tickerValid, reason: reasonLabel(Number(tickerReason)) },
      ok: nameValid && tickerValid,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'name-check read failed' }, { status: 500 });
  }
}
