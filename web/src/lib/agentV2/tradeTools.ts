/// Phase 1b trade tools: buy / sell quotes (bonding curve or graduated Uniswap v4
/// pool), Fair opening-batch deposit and claim, and creator fee claims. Every tool
/// returns unsigned transactions for the caller's own wallet, with `minOut` taken
/// from a live quote minus a slippage cap the caller sets, plus an eth_call
/// simulation when nothing else (an approve) has to land first.
///
/// Scope: ETH-paired tokens on the token lane and the Fair lane. DN404 tokens
/// (NFT gas caps, taxes, URU-paired pools) are refused with a pointer to the site.

import { encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, keccak256, parseAbi, parseEther, parseUnits, type Address, type Hex } from 'viem';

import { bondingCurveAbi, erc20TokenAbi, fairHookHostAbi, fairLaunchFactoryAbi, multiHookHostAbi, openingBatchAbi, v4StateViewAbi, v4SwapRouterAbi, curveFactoryAbi, dn404CurveFactoryAbi } from '../abis';
import { legacyHookOverride } from '../legacyGraduations';
import type { UnsignedTx } from '../launchTx';
import { addressField } from './schema';
import {
  AGENT_V2_CHAIN_ID,
  fmtEth,
  MINUTE,
  revertMessage,
  settledAny,
  simulate,
  SITE,
  ToolError,
  txOut,
  ZERO,
  type AgentDeps,
  type ToolDef,
  type ToolOutput,
} from './tools';

// ---------------------------------------------------------------- shared

const DEADLINE_SECS = 300;
const DEFAULT_SLIPPAGE_BPS = 200;
const MAX_SLIPPAGE_BPS = 2_000;

const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  // Non-view on chain (it reverts internally to return), read here through eth_call.
  'function quoteExactInputSingle(QuoteExactSingleParams params) view returns (uint256 amountOut, uint256 gasEstimate)',
]);
const fairCurveAbi = parseAbi([
  'function launcher() view returns (address)',
  'function batch() view returns (address)',
  'function quoteBatchBuy(uint256 ethIn) view returns (uint256 tokensOut, uint256 ethUsed, uint256 ethRefund)',
]);
const batchExtraAbi = parseAbi(['function walletCap() view returns (uint256)']);

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/// ETH/token pool key at a hook, the fixed graduation shape (fee 3000, spacing 60).
export function ethPoolKey(token: Address, hook: Address): PoolKey {
  return { currency0: ZERO, currency1: token, fee: 3000, tickSpacing: 60, hooks: hook };
}

export function poolIdOf(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

export function applySlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

const slippageField = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_SLIPPAGE_BPS,
  default: DEFAULT_SLIPPAGE_BPS,
  description: `Max slippage in basis points (100 = 1%). minOut = quote minus this. Default ${DEFAULT_SLIPPAGE_BPS}, max ${MAX_SLIPPAGE_BPS}.`,
} as const;
const ethField = (description: string) => ({ type: 'string', pattern: '^(0|[1-9]\\d{0,6})(\\.\\d{1,18})?$', description }) as const;
const tokenAmountField = { type: 'string', pattern: '^(0|[1-9]\\d{0,14})(\\.\\d{1,18})?$', description: 'Token amount in whole tokens (18 decimals), e.g. "1500000"' } as const;

type Market =
  | { kind: 'curve'; lane: 'token' | 'fair'; token: Address; curve: Address }
  | { kind: 'pool'; lane: 'token' | 'fair'; token: Address; curve: Address; key: PoolKey; poolId: Hex };

/// Where a token trades right now. Chain reads decide; the indexer only supplies
/// the hook for a graduated token-lane pool.
async function resolveMarket({ client, book, indexer }: AgentDeps, token: Address): Promise<Market> {
  const r = (address: Address, abi: Parameters<AgentDeps['client']['readContract']>[0]['abi'], functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as Parameters<AgentDeps['client']['readContract']>[0]) as Promise<unknown>;
  const [fairCurve, tokenCurve, dnCurve, dnRow] = (await Promise.allSettled([
    r(book.FairLaunchFactory, fairLaunchFactoryAbi, 'curveFor', [token]),
    r(book.CurveFactory, curveFactoryAbi, 'curveFor', [token]),
    book.Dn404CurveFactory ? r(book.Dn404CurveFactory, dn404CurveFactoryAbi, 'curveFor', [token]) : Promise.resolve(ZERO),
    indexer.dn404ForBase(token),
  ])).map(settledAny) as [Address | null, Address | null, Address | null, unknown];
  if (dnRow || (dnCurve && dnCurve !== ZERO)) {
    throw new ToolError('UNSUPPORTED', 'DN404 tokens (NFT mint limits, token taxes, URU pools) are not tradable through the agent API yet. Use the website trade page.', 409);
  }
  const lane: 'token' | 'fair' = fairCurve && fairCurve !== ZERO ? 'fair' : 'token';
  const curve = lane === 'fair' ? fairCurve! : tokenCurve && tokenCurve !== ZERO ? tokenCurve : null;
  if (!curve) throw new ToolError('NOT_FOUND', 'No urufu bonding curve for this token.', 404);
  const graduated = (await r(curve, bondingCurveAbi, 'graduated')) as boolean;
  if (!graduated) return { kind: 'curve', lane, token, curve };

  let hook: Address;
  if (lane === 'fair') hook = book.FairHookHost;
  else {
    const legacy = legacyHookOverride(token);
    const grad = legacy ? null : await indexer.graduationForToken(token).catch(() => null);
    hook = legacy ?? grad?.hookAddress ?? book.MultiHookHost;
  }
  const key = ethPoolKey(token, getAddress(hook));
  const poolId = poolIdOf(key);
  const slot0 = (await r(book.StateView, v4StateViewAbi, 'getSlot0', [poolId])) as readonly [bigint, number, number, number];
  if (slot0[0] === 0n) throw new ToolError('UPSTREAM', 'The token graduated but its Uniswap v4 pool was not found. Use the website trade page.', 502);
  return { kind: 'pool', lane, token, curve, key, poolId };
}

async function quoteV4(deps: AgentDeps, key: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  try {
    const [out] = (await deps.client.readContract({
      address: deps.book.V4Quoter,
      abi: quoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    })) as readonly [bigint, bigint];
    return out;
  } catch (err) {
    throw new ToolError('QUOTE_FAILED', `The pool would not quote this trade (${revertMessage(err)}). It may be too large, or trading may still be gated right after graduation.`, 409);
  }
}

function deadline(deps: AgentDeps): bigint {
  return BigInt(Math.floor(deps.now() / 1000) + DEADLINE_SECS);
}

async function finish(
  deps: AgentDeps,
  from: Address,
  last: UnsignedTx,
  errors: string[],
  needsApprove: boolean,
): Promise<{ ok: boolean; error: string | null; skipped?: string }> {
  if (errors.length > 0) return { ok: false, error: null, skipped: 'blocking errors' };
  if (needsApprove) return { ok: false, error: null, skipped: 'needs the approve first' };
  const sim = await simulate(deps.client, from, last);
  if (!sim.ok && sim.error) errors.push(`Simulation reverted: ${sim.error}`);
  return sim;
}

const NEXT = 'Show `summary` to the human and wait for a clear yes. Sign each transaction in `step` order with the same wallet, then call verify_tx.';

// ---------------------------------------------------------------- quote_buy

interface BuyInput { token: string; buyer: string; ethIn: string; maxSlippageBps: number }

export const quoteBuyTool: ToolDef<BuyInput> = {
  name: 'quote_buy',
  title: 'Quote a buy (unsigned tx)',
  description: 'Build an unsigned buy of a token with ETH: on its bonding curve, or on its Uniswap v4 pool after graduation. Returns the expected tokens, minOut after your slippage cap, and the tx. Nothing is signed or sent.',
  inputSchema: {
    type: 'object',
    properties: {
      token: addressField('Token to buy'),
      buyer: addressField('Wallet that signs, pays and receives the tokens'),
      ethIn: ethField('ETH to spend, e.g. "0.05"'),
      maxSlippageBps: slippageField,
    },
    required: ['token', 'buyer', 'ethIn'],
    additionalProperties: false,
  },
  rate: { limit: 30, windowMs: MINUTE },
  cacheTtlMs: 3_000,
  async handler(deps, input) {
    const token = getAddress(input.token);
    const buyer = getAddress(input.buyer);
    const ethIn = parseEther(input.ethIn);
    if (ethIn === 0n) throw new ToolError('INVALID_INPUT', '`ethIn` must be more than 0');
    const market = await resolveMarket(deps, token);
    const errors: string[] = [];
    const warnings: string[] = [];
    const balance = await deps.client.getBalance({ address: buyer });
    if (balance < ethIn) errors.push(`Buyer has ${fmtEth(balance)} but the buy needs ${fmtEth(ethIn)} plus gas.`);

    let expected: bigint;
    let tx: UnsignedTx;
    let venue: string;
    if (market.kind === 'curve') {
      if (market.lane === 'fair') await assertFairCurveOpen(deps, market.curve);
      const [out, fee] = (await deps.client.readContract({ address: market.curve, abi: bondingCurveAbi, functionName: 'quoteBuy', args: [ethIn] })) as readonly [bigint, bigint];
      if (out === 0n) throw new ToolError('QUOTE_FAILED', 'The curve returns 0 tokens for this amount.', 409);
      expected = out;
      const minOut = applySlippage(out, input.maxSlippageBps);
      tx = { to: market.curve, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: 'buy', args: [minOut] }), value: ethIn };
      venue = 'bonding curve';
      warnings.push(`Curve trade fee: ${fmtEth(fee)}. A buy that reaches the graduation target graduates the token in the same tx.`);
    } else {
      expected = await quoteV4(deps, market.key, true, ethIn);
      const minOut = applySlippage(expected, input.maxSlippageBps);
      tx = {
        to: deps.book.V4SwapRouter,
        data: encodeFunctionData({ abi: v4SwapRouterAbi, functionName: 'swapExactETHForToken', args: [market.key, minOut, buyer, deadline(deps)] }),
        value: ethIn,
      };
      venue = 'Uniswap v4 pool';
      if (market.lane === 'fair') warnings.push('Fair pools charge a sniper tax for 5 minutes after graduation (20% falling to 0%). The quote already includes it.');
    }
    const minOut = applySlippage(expected, input.maxSlippageBps);
    const summary = `Buy about ${formatUnits(expected, 18)} tokens of ${token} on the ${venue} for ${fmtEth(ethIn)} from ${buyer}. You get at least ${formatUnits(minOut, 18)} or the tx reverts.`;
    const steps = [txOut(tx, 1, 'buy', summary)];
    const simulation = await finish(deps, buyer, tx, errors, false);
    return out({
      lane: market.lane, venue, token, buyer,
      ethIn: ethIn.toString(), expectedTokens: expected.toString(), minTokensOut: minOut.toString(),
      maxSlippageBps: input.maxSlippageBps, poolId: market.kind === 'pool' ? market.poolId : null,
      transactions: steps, simulation, errors, warnings, summary,
    });
  },
};

// ---------------------------------------------------------------- quote_sell

interface SellInput { token: string; seller: string; tokenAmount: string; maxSlippageBps: number }

export const quoteSellTool: ToolDef<SellInput> = {
  name: 'quote_sell',
  title: 'Quote a sell (unsigned tx)',
  description: 'Build an unsigned sell of a token for ETH: on its bonding curve, or on its Uniswap v4 pool after graduation. Adds an exact-amount approve first when needed. Warns when a Fair creator sell would burn their creator fee.',
  inputSchema: {
    type: 'object',
    properties: {
      token: addressField('Token to sell'),
      seller: addressField('Wallet that holds the tokens, signs and receives the ETH'),
      tokenAmount: tokenAmountField,
      maxSlippageBps: slippageField,
    },
    required: ['token', 'seller', 'tokenAmount'],
    additionalProperties: false,
  },
  rate: { limit: 30, windowMs: MINUTE },
  cacheTtlMs: 3_000,
  async handler(deps, input) {
    const token = getAddress(input.token);
    const seller = getAddress(input.seller);
    const amount = parseUnits(input.tokenAmount, 18);
    if (amount === 0n) throw new ToolError('INVALID_INPUT', '`tokenAmount` must be more than 0');
    const market = await resolveMarket(deps, token);
    const spender = market.kind === 'curve' ? market.curve : deps.book.V4SwapRouter;
    const [bal, allowance] = (await Promise.all([
      deps.client.readContract({ address: token, abi: erc20TokenAbi, functionName: 'balanceOf', args: [seller] }),
      deps.client.readContract({ address: token, abi: erc20TokenAbi, functionName: 'allowance', args: [seller, spender] }),
    ])) as [bigint, bigint];
    const errors: string[] = [];
    const warnings: string[] = [];
    if (bal < amount) errors.push(`Seller holds ${formatUnits(bal, 18)} tokens but wants to sell ${input.tokenAmount}.`);

    let expected: bigint;
    let tx: UnsignedTx;
    let venue: string;
    if (market.kind === 'curve') {
      if (market.lane === 'fair') await assertFairCurveOpen(deps, market.curve);
      const [ethOut] = (await deps.client.readContract({ address: market.curve, abi: bondingCurveAbi, functionName: 'quoteSell', args: [amount] })) as readonly [bigint, bigint];
      if (ethOut === 0n) throw new ToolError('QUOTE_FAILED', 'The curve returns 0 ETH for this amount.', 409);
      expected = ethOut;
      tx = { to: market.curve, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: 'sell', args: [amount, applySlippage(ethOut, input.maxSlippageBps)] }), value: 0n };
      venue = 'bonding curve';
    } else {
      expected = await quoteV4(deps, market.key, false, amount);
      tx = {
        to: deps.book.V4SwapRouter,
        data: encodeFunctionData({ abi: v4SwapRouterAbi, functionName: 'swapExactTokenForETH', args: [market.key, amount, applySlippage(expected, input.maxSlippageBps), seller, deadline(deps)] }),
        value: 0n,
      };
      venue = 'Uniswap v4 pool';
    }
    if (market.lane === 'fair') warnings.push(...(await fairCreatorSellWarnings(deps, market, seller, bal, amount)));

    const minOut = applySlippage(expected, input.maxSlippageBps);
    const steps: ReturnType<typeof txOut>[] = [];
    const needsApprove = allowance < amount;
    if (needsApprove) {
      steps.push(txOut(
        { to: token, data: encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [spender, amount] }), value: 0n },
        1, 'approve', `Allow the ${venue} to take exactly ${input.tokenAmount} tokens for this sell.`,
      ));
    }
    const summary = `Sell ${input.tokenAmount} tokens of ${token} on the ${venue} from ${seller} for about ${fmtEth(expected)}. You get at least ${fmtEth(minOut)} or the tx reverts.`;
    steps.push(txOut(tx, steps.length + 1, 'sell', summary));
    const simulation = await finish(deps, seller, tx, errors, needsApprove);
    return out({
      lane: market.lane, venue, token, seller,
      tokenAmount: amount.toString(), expectedEth: expected.toString(), minEthOut: minOut.toString(),
      maxSlippageBps: input.maxSlippageBps, poolId: market.kind === 'pool' ? market.poolId : null,
      transactions: steps, simulation, errors, warnings, summary,
    });
  },
};

/// Fair creators lose their creator fee for good if their balance falls more than
/// 10% below their balance at graduation. Say so before they sign.
async function fairCreatorSellWarnings(deps: AgentDeps, market: Market, seller: Address, balance: bigint, amount: bigint): Promise<string[]> {
  if (market.kind === 'curve') {
    const launcher = (await deps.client.readContract({ address: market.curve, abi: fairCurveAbi, functionName: 'launcher' }).catch(() => null)) as Address | null;
    return launcher && launcher.toLowerCase() === seller.toLowerCase()
      ? ['You are this token\'s creator. Fair rule: if your balance ends up more than 10% below your balance at graduation, your creator fee is burned for good.']
      : [];
  }
  const pool = (await deps.client.readContract({ address: deps.book.FairHookHost, abi: fairHookHostAbi, functionName: 'pools', args: [market.poolId] }).catch(() => null)) as
    | readonly [Address, Address, bigint, number, number, number, boolean, boolean, bigint]
    | null;
  if (!pool || pool[1].toLowerCase() !== seller.toLowerCase()) return [];
  if (pool[7]) return ['You are this token\'s creator; your creator fee was already forfeited.'];
  const baseline = pool[8];
  const after = balance - (amount > balance ? balance : amount);
  if (after * 10n < baseline * 9n) {
    return [`STOP: you are this token's creator. After this sell your balance (${formatUnits(after, 18)}) is more than 10% below your graduation balance (${formatUnits(baseline, 18)}), so your creator fee is burned for good.`];
  }
  return ['You are this token\'s creator. Keep your balance within 10% of your graduation balance or your creator fee is burned for good.'];
}

async function assertFairCurveOpen(deps: AgentDeps, curve: Address) {
  const batch = (await deps.client.readContract({ address: curve, abi: fairCurveAbi, functionName: 'batch' })) as Address;
  const [closeTs, block] = await Promise.all([
    deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'closeTs' }) as Promise<bigint>,
    deps.client.getBlock({ blockTag: 'latest' }),
  ]);
  if (block.timestamp < closeTs) {
    throw new ToolError('BATCH_OPEN', `The opening batch is still running for ${closeTs - block.timestamp} s; the curve opens after it. Use quote_batch_deposit to join the batch at the shared price.`, 409);
  }
}

// ---------------------------------------------------------------- Fair batch

async function batchFor(deps: AgentDeps, token: Address): Promise<Address> {
  const b = (await deps.client.readContract({ address: deps.book.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'batchFor', args: [token] })) as Address;
  if (!b || b === ZERO) throw new ToolError('NOT_FOUND', 'This token has no Fair opening batch (not a Fair launch).', 404);
  return b;
}

interface DepositInput { token: string; depositor: string; ethIn: string }

export const quoteBatchDepositTool: ToolDef<DepositInput> = {
  name: 'quote_batch_deposit',
  title: 'Join a Fair opening batch (unsigned tx)',
  description: 'Build an unsigned deposit into a Fair token\'s 60 s opening batch. Every deposit buys at one shared price when the batch settles; above the 25% curve cap, deposits are filled pro rata and the rest is refunded on claim. Returns an estimate of your share.',
  inputSchema: {
    type: 'object',
    properties: {
      token: addressField('Fair token'),
      depositor: addressField('Wallet that signs and deposits'),
      ethIn: ethField('ETH to deposit, e.g. "0.1"'),
    },
    required: ['token', 'depositor', 'ethIn'],
    additionalProperties: false,
  },
  rate: { limit: 30, windowMs: MINUTE },
  cacheTtlMs: 2_000,
  async handler(deps, input) {
    const token = getAddress(input.token);
    const depositor = getAddress(input.depositor);
    const ethIn = parseEther(input.ethIn);
    if (ethIn === 0n) throw new ToolError('INVALID_INPUT', '`ethIn` must be more than 0');
    const batch = await batchFor(deps, token);
    const curve = (await deps.client.readContract({ address: deps.book.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'curveFor', args: [token] })) as Address;
    const [closeTs, settled, total, mine, cap, block, balance] = await Promise.all([
      deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'closeTs' }) as Promise<bigint>,
      deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'settled' }) as Promise<boolean>,
      deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'totalDeposited' }) as Promise<bigint>,
      deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'deposits', args: [depositor] }) as Promise<bigint>,
      deps.client.readContract({ address: batch, abi: batchExtraAbi, functionName: 'walletCap' }).catch(() => 0n) as Promise<bigint>,
      deps.client.getBlock({ blockTag: 'latest' }),
      deps.client.getBalance({ address: depositor }),
    ]);
    const errors: string[] = [];
    const warnings: string[] = [];
    const secondsLeft = closeTs > block.timestamp ? Number(closeTs - block.timestamp) : 0;
    if (settled || secondsLeft === 0) errors.push('The opening batch is closed. Use quote_buy to buy on the curve instead.');
    else if (secondsLeft < 15) warnings.push(`Only ${secondsLeft} s left in the batch; a tx that lands after the window reverts.`);
    if (cap > 0n && mine + ethIn > cap) errors.push(`Per-wallet cap is ${fmtEth(cap)}; you have ${fmtEth(mine)} in already.`);
    if (balance < ethIn) errors.push(`Depositor has ${fmtEth(balance)} but needs ${fmtEth(ethIn)} plus gas.`);

    // Estimate of this wallet's share if nobody else joins after it.
    let estimate: { tokens: string; refundEth: string } | null = null;
    try {
      const [tokensOut, , refund] = (await deps.client.readContract({ address: curve, abi: fairCurveAbi, functionName: 'quoteBatchBuy', args: [total + ethIn] })) as readonly [bigint, bigint, bigint];
      const after = total + ethIn;
      const userTotal = mine + ethIn;
      estimate = { tokens: ((tokensOut * userTotal) / after).toString(), refundEth: ((refund * userTotal) / after).toString() };
    } catch { /* estimate is optional */ }

    const tx: UnsignedTx = { to: batch, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'deposit' }), value: ethIn };
    const summary = `Deposit ${fmtEth(ethIn)} into the Fair opening batch of ${token} from ${depositor} (${secondsLeft} s left). Tokens and any refund are claimed after the batch settles.`;
    const steps = [txOut(tx, 1, 'deposit', summary)];
    const simulation = await finish(deps, depositor, tx, errors, false);
    warnings.push('The final price and your share depend on every deposit in the batch; the estimate assumes nobody else joins after you.');
    return out({
      token, batch, depositor, ethIn: ethIn.toString(), secondsLeft,
      batchTotalBefore: total.toString(), yourDepositBefore: mine.toString(), walletCap: cap.toString(),
      estimateIfNoMoreDeposits: estimate, transactions: steps, simulation, errors, warnings, summary,
    });
  },
};

interface ClaimInput { token: string; user: string }

export const buildBatchClaimTool: ToolDef<ClaimInput> = {
  name: 'build_batch_claim',
  title: 'Claim from a Fair opening batch (unsigned txs)',
  description: 'Build the unsigned txs to collect a wallet\'s Fair batch tokens and refund: settle (anyone can, once the window closes), claim, and withdraw a refund that could not be pushed.',
  inputSchema: {
    type: 'object',
    properties: { token: addressField('Fair token'), user: addressField('Wallet that deposited') },
    required: ['token', 'user'],
    additionalProperties: false,
  },
  rate: { limit: 30, windowMs: MINUTE },
  cacheTtlMs: 3_000,
  async handler(deps, input) {
    const token = getAddress(input.token);
    const user = getAddress(input.user);
    const batch = await batchFor(deps, token);
    const [closeTs, settled, dep, claimed, owed, block] = await Promise.all([
      deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'closeTs' }) as Promise<bigint>,
      deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'settled' }) as Promise<boolean>,
      deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'deposits', args: [user] }) as Promise<bigint>,
      deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'claimed', args: [user] }) as Promise<boolean>,
      deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'refundOwed', args: [user] }) as Promise<bigint>,
      deps.client.getBlock({ blockTag: 'latest' }),
    ]);
    if (dep === 0n && owed === 0n) throw new ToolError('NOTHING_TO_CLAIM', 'This wallet has no deposit and no refund owed in this batch.', 404);
    const steps: ReturnType<typeof txOut>[] = [];
    const errors: string[] = [];
    if (!settled) {
      if (block.timestamp < closeTs) throw new ToolError('BATCH_OPEN', `The batch window is still open for ${closeTs - block.timestamp} s. Claim after it closes.`, 409);
      steps.push(txOut({ to: batch, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'settle' }), value: 0n }, 1, 'settle', 'Settle the opening batch (one shared buy for everyone). Anyone can send this; it only needs to happen once.'));
    }
    let pending: { tokens: string; refundEth: string } | null = null;
    if (dep > 0n && !claimed) {
      if (settled) {
        const [t, rf] = (await deps.client.readContract({ address: batch, abi: openingBatchAbi, functionName: 'pending', args: [user] })) as readonly [bigint, bigint];
        pending = { tokens: t.toString(), refundEth: rf.toString() };
      }
      steps.push(txOut({ to: batch, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'claim' }), value: 0n }, steps.length + 1, 'claim', `Claim this wallet's batch tokens${pending ? ` (${formatUnits(BigInt(pending.tokens), 18)})` : ''} and any ETH refund. Must be sent from ${user}.`));
    }
    if (owed > 0n) {
      steps.push(txOut({ to: batch, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'withdrawRefund', args: [user] }), value: 0n }, steps.length + 1, 'withdrawRefund', `Withdraw a parked refund of ${fmtEth(owed)} to ${user}. Must be sent from ${user}.`));
    }
    if (steps.length === 0) throw new ToolError('NOTHING_TO_CLAIM', 'Already claimed, and no refund is owed.', 404);
    const lastTx = { to: steps[steps.length - 1]!.to, data: steps[steps.length - 1]!.data, value: 0n };
    const simulation = await finish(deps, user, lastTx, errors, steps.length > 1);
    return out({
      token, batch, user, settled, deposit: dep.toString(), claimed, refundOwed: owed.toString(), pending,
      transactions: steps, simulation, errors, warnings: [], summary: `Collect Fair batch proceeds for ${user} on ${token}: ${steps.map((s) => s.purpose).join(', then ')}.`,
    });
  },
};

// ---------------------------------------------------------------- creator fees

interface FeesInput { wallet: string }

export const buildClaimCreatorFeesTool: ToolDef<FeesInput> = {
  name: 'build_claim_creator_fees',
  title: 'Claim creator fees (unsigned txs)',
  description: 'Find every creator fee a wallet can claim (token-lane pools on the MultiHookHost, Fair pools on the FairHookHost) and build the unsigned claim txs. MultiHookHost claims pay the sender, so send them from the creator wallet; Fair claims always pay the creator.',
  inputSchema: {
    type: 'object',
    properties: { wallet: addressField('Creator wallet') },
    required: ['wallet'],
    additionalProperties: false,
  },
  rate: { limit: 20, windowMs: MINUTE },
  cacheTtlMs: 10_000,
  async handler(deps, input) {
    const wallet = getAddress(input.wallet);
    const launches = (await deps.indexer.launchesByCreator(wallet)) ?? [];
    const tokenLane = launches.filter((l) => l.lane !== 'fair').slice(0, 50);
    const fair = launches.filter((l) => l.lane === 'fair').slice(0, 50);

    const hooks = new Set<string>([deps.book.MultiHookHost.toLowerCase(), deps.book.LegacyMultiHookHost.toLowerCase()]);
    const grads = await Promise.all(tokenLane.map((l) => deps.indexer.graduationForToken(l.tokenAddress).catch(() => null)));
    for (const g of grads) if (g?.hookAddress) hooks.add(g.hookAddress.toLowerCase());

    const steps: ReturnType<typeof txOut>[] = [];
    const found: Array<Record<string, unknown>> = [];
    for (const h of hooks) {
      const hook = getAddress(h);
      const owed = (await deps.client.readContract({ address: hook, abi: multiHookHostAbi, functionName: 'owed', args: [ZERO, wallet] }).catch(() => 0n)) as bigint;
      if (owed === 0n) continue;
      found.push({ venue: 'MultiHookHost', hook, claimableEth: owed.toString() });
      steps.push(txOut({ to: hook, data: encodeFunctionData({ abi: multiHookHostAbi, functionName: 'claim', args: [ZERO] }), value: 0n }, steps.length + 1, 'claim', `Claim ${fmtEth(owed)} of token-lane creator fees from MultiHookHost ${hook}. Pays the sender: send from ${wallet}.`));
    }
    for (const l of fair) {
      const poolId = poolIdOf(ethPoolKey(getAddress(l.tokenAddress), deps.book.FairHookHost));
      const [fees, forfeited] = (await Promise.allSettled([
        deps.client.readContract({ address: deps.book.FairHookHost, abi: fairHookHostAbi, functionName: 'creatorFees', args: [poolId] }),
        deps.client.readContract({ address: deps.book.FairHookHost, abi: fairHookHostAbi, functionName: 'isForfeited', args: [poolId] }),
      ])).map(settledAny) as [readonly [bigint, bigint, bigint, bigint] | null, boolean | null];
      if (!fees) continue;
      const [pendingEth, pendingToken, claimableEth, claimableToken] = fees;
      if (forfeited) { found.push({ venue: 'FairHookHost', token: l.tokenAddress, poolId, forfeited: true }); continue; }
      if (claimableEth === 0n && claimableToken === 0n && pendingEth === 0n && pendingToken === 0n) continue;
      found.push({ venue: 'FairHookHost', token: l.tokenAddress, poolId, pendingEth: pendingEth.toString(), pendingToken: pendingToken.toString(), claimableEth: claimableEth.toString(), claimableToken: claimableToken.toString() });
      if (claimableEth > 0n || claimableToken > 0n) {
        steps.push(txOut({ to: deps.book.FairHookHost, data: encodeFunctionData({ abi: fairHookHostAbi, functionName: 'claimCreatorFees', args: [poolId] }), value: 0n }, steps.length + 1, 'claimCreatorFees', `Claim Fair creator fees for ${l.tokenAddress}: ${fmtEth(claimableEth)} and ${formatUnits(claimableToken, 18)} tokens. Paid to the creator whoever sends it.`));
      }
    }
    if (launches.length === 0) return out({ wallet, launches: 0, fees: [], transactions: [], errors: [], warnings: ['No launches found for this wallet.'], summary: 'Nothing to claim.' });
    const summary = steps.length === 0 ? 'No creator fees are claimable right now.' : `Claim creator fees for ${wallet}: ${steps.length} transaction(s).`;
    return out({ wallet, launches: launches.length, fees: found, transactions: steps, errors: [], warnings: [], summary });
  },
};

// ---------------------------------------------------------------- helpers

function out(data: Record<string, unknown>): ToolOutput {
  const errors = (data.errors as string[] | undefined) ?? [];
  return {
    data: {
      chainId: AGENT_V2_CHAIN_ID,
      ...data,
      canBroadcast: errors.length === 0 && ((data.transactions as unknown[] | undefined)?.length ?? 0) > 0,
      links: data.token ? { trade: `${SITE}/trade/${data.token as string}` } : undefined,
      next: NEXT,
    },
  };
}


export const TRADE_TOOLS = [quoteBuyTool, quoteSellTool, quoteBatchDepositTool, buildBatchClaimTool, buildClaimCreatorFeesTool] as unknown as ReadonlyArray<ToolDef<never>>;
