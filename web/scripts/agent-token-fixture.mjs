// Writes contracts/test/agent/fixtures/agent-token.json: the exact calldata that
// web/src/lib/agentV2/agentPolicy.ts builds for a phase 2 agent token (the agent
// account's Safe launches its own Fair token, listed for the agent with selling
// off) plus a scripted run in phases, each step marked ok / revert.
// contracts/test/agent/AgentTokenFork.t.sol replays it on a Robinhood fork, with
// graduation, the fee checks and the owner's forfeiting sale done in Solidity.
//
// Re-run after any change to agentPolicy.ts:
//   cd web
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     --import ./scripts/ts-resolve.mjs scripts/agent-token-fixture.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeFunctionResult, encodeAbiParameters, encodeErrorResult, encodeFunctionData, http, parseAbi, parseEther } from 'viem';

import { bondingCurveAbi, erc20TokenAbi, fairHookHostAbi, fairLaunchFactoryAbi, openingBatchAbi, v4SwapRouterAbi } from '../src/lib/abis.ts';
import {
  agentExecTx, agentTokenLaunchCalls, configureCalls, createSafeTx, deployRolesTx, moduleProxyFactoryAbi, safeBatchTx, safeProxyFactoryAbi,
} from '../src/lib/agentV2/agentPolicy.ts';
import { buildFairLaunchTx } from '../src/lib/launchTx.ts';
import { ethPoolKey, poolIdOf } from '../src/lib/agentV2/tradeTools.ts';
import { BOOK } from '../src/lib/agentV2/testFixtures.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'test', 'agent', 'fixtures', 'agent-token.json');
const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });

const OWNER = '0x0000000000000000000000000000000000a9e001';
const AGENT = '0x0000000000000000000000000000000000a9e002';
const OUTSIDER = '0x0000000000000000000000000000000000a9e003';
const FROM = { owner: 0, agent: 1, outsider: 2 };
const FAR_DEADLINE = 2n ** 40n;
const SALT = 0x75727567n; // "urug"
const NAME = 'Agent Token Fork Test';
const TICKER = 'ATFT';
const DEPOSIT = parseEther('0.2');

const rolesErrors = parseAbi(['error ConditionViolation(uint8 status, bytes32 info)']);
const violation = (status) => encodeErrorResult({ abi: rolesErrors, errorName: 'ConditionViolation', args: [status, '0x' + '00'.repeat(32)] }).slice(0, 2 + 8 + 64);
/// Roles v2 Status: 2 TargetAddressNotAllowed, 3 FunctionNotAllowed.
const FUNCTION = violation(3);

const phases = { a: [], b: [], c: [] };
const step = (phase, label, from, tx, expect, warpBefore = 0) =>
  phases[phase].push({
    label, from: FROM[from], to: tx.to, value: tx.value ?? 0n, data: tx.data ?? '0x',
    expectOk: expect === true, expectRevert: expect === true ? '0x' : expect, warpBefore: BigInt(warpBefore),
  });

const cs = createSafeTx(OWNER, SALT);
const safe = decodeFunctionResult({ abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', data: (await client.call({ account: OWNER, to: cs.to, data: cs.data })).data });
const dr = deployRolesTx(safe, SALT);
const roles = decodeFunctionResult({ abi: moduleProxyFactoryAbi, functionName: 'deployModule', data: (await client.call({ account: OWNER, to: dr.to, data: dr.data })).data });

const policyBase = {
  v4SwapRouter: BOOK.V4SwapRouter,
  hooks: [BOOK.MultiHookHost, BOOK.LegacyMultiHookHost, BOOK.FairHookHost],
  multiHookHosts: [BOOK.MultiHookHost, BOOK.LegacyMultiHookHost],
  fairHookHost: BOOK.FairHookHost,
  fairLaunchFactory: BOOK.FairLaunchFactory,
};

const fee = await client.readContract({ address: BOOK.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'ethFeeFor', args: [safe] });
const [token, curve, batch] = await client.readContract({ address: BOOK.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'predictAddresses', args: [safe, NAME, TICKER] });
const key = ethPoolKey(token, BOOK.FairHookHost);
const poolId = poolIdOf(key);

const asAgent = (inner) => agentExecTx(roles, inner);
const swapIn = (ethIn, recipient) => ({ to: BOOK.V4SwapRouter, value: ethIn, data: encodeFunctionData({ abi: v4SwapRouterAbi, functionName: 'swapExactETHForToken', args: [key, 1n, recipient, FAR_DEADLINE] }) });
const v4Sell = { to: BOOK.V4SwapRouter, value: 0n, data: encodeFunctionData({ abi: v4SwapRouterAbi, functionName: 'swapExactTokenForETH', args: [key, parseEther('1'), 0n, safe, FAR_DEADLINE] }) };

// ---- A: setup, the Safe launches its own token, the agent uses the batch
step('a', 'create Safe', 'owner', cs, true);
step('a', 'deploy Roles', 'owner', dr, true);
step('a', 'arm policy, no tokens yet (one Safe tx)', 'owner', safeBatchTx(safe, OWNER, configureCalls({ safe, roles, agent: AGENT, policy: { ...policyBase, tokens: [] }, dailyWei: parseEther('0.25'), perTradeWei: parseEther('0.05'), allowFairLaunch: false })), true);
step('a', 'fund Safe 3 ETH', 'owner', { to: safe, value: parseEther('3'), data: '0x' }, true);
const launch = buildFairLaunchTx({ factory: BOOK.FairLaunchFactory, name: NAME, ticker: TICKER, payWith: 'ETH', fee, depositWei: DEPOSIT });
step('a', 'owner launches the agent token from the Safe and lists it, selling off (one Safe tx)', 'owner',
  safeBatchTx(safe, OWNER, agentTokenLaunchCalls({ roles, policy: policyBase, launch: [launch], own: { token, curve, batch }, listed: [] })), true);
step('a', 'agent deposits 0.02 into its own batch', 'agent', asAgent({ to: batch, value: parseEther('0.02'), data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'deposit' }) }), true, 2);
step('a', 'agent approves its own token to the curve', 'agent', asAgent({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [curve, parseEther('1')] }) }), FUNCTION);
step('a', 'agent approves its own token to the V4SwapRouter', 'agent', asAgent({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [BOOK.V4SwapRouter, parseEther('1')] }) }), FUNCTION);
step('a', 'agent transfers its own token out', 'agent', asAgent({ to: token, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [OUTSIDER, 1n] }) }), FUNCTION);
step('a', 'agent sells its own token on the curve', 'agent', asAgent({ to: curve, value: 0n, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: 'sell', args: [1n, 0n] }) }), FUNCTION);
step('a', 'agent settles the batch', 'agent', asAgent({ to: batch, value: 0n, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'settle' }) }), true, 3_600);
step('a', 'agent claims batch tokens to the Safe', 'agent', asAgent({ to: batch, value: 0n, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'claim' }) }), true);
step('a', 'agent buys its own token on the curve', 'agent', asAgent({ to: curve, value: parseEther('0.01'), data: encodeFunctionData({ abi: bondingCurveAbi, functionName: 'buy', args: [0n] }) }), true, 2);

// ---- (Solidity: graduate the curve, wait out the anti-sniper gate)

// ---- B: the pool trades, fees accrue to the Safe; the agent still can't sell
step('b', 'outsider buys 1 ETH on the v4 pool', 'outsider', swapIn(parseEther('1'), OUTSIDER), true);
step('b', 'outsider buys 0.5 ETH on the v4 pool', 'outsider', swapIn(parseEther('0.5'), OUTSIDER), true, 2);
step('b', 'outsider approves the V4SwapRouter', 'outsider', { to: token, value: 0n, data: encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [BOOK.V4SwapRouter, parseEther('1000000')] }) }, true);
// Buys pay the creator share in tokens, sells in ETH: both sides accrue.
step('b', 'outsider sells 1M tokens on the v4 pool', 'outsider', { to: BOOK.V4SwapRouter, value: 0n, data: encodeFunctionData({ abi: v4SwapRouterAbi, functionName: 'swapExactTokenForETH', args: [key, parseEther('1000000'), 0n, OUTSIDER, FAR_DEADLINE] }) }, true, 2);
step('b', 'agent buys its own token on v4, recipient = Safe', 'agent', asAgent(swapIn(parseEther('0.01'), safe)), true, 2);
step('b', 'agent sells its own token on v4', 'agent', asAgent(v4Sell), FUNCTION);
step('b', 'agent approves its own token after graduation', 'agent', asAgent({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [BOOK.V4SwapRouter, parseEther('1')] }) }), FUNCTION);

// ---- C: the agent claims the creator fee into the Safe
step('c', 'agent claims the creator fee (paid to the Safe)', 'agent', asAgent({ to: BOOK.FairHookHost, value: 0n, data: encodeFunctionData({ abi: fairHookHostAbi, functionName: 'claimCreatorFees', args: [poolId] }) }), true, 2);

// ---- (Solidity: the owner sells most of the Safe's tokens; the forfeit fires)

const stepType = [{ type: 'tuple[]', components: [
  { name: 'label', type: 'string' }, { name: 'from', type: 'uint8' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' }, { name: 'expectOk', type: 'bool' }, { name: 'expectRevert', type: 'bytes' }, { name: 'warpBefore', type: 'uint64' },
] }];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  note: 'Generated by web/scripts/agent-token-fixture.mjs from web/src/lib/agentV2/agentPolicy.ts. Do not edit by hand.',
  owner: OWNER, agent: AGENT, outsider: OUTSIDER, safe, roles,
  fairHookHost: BOOK.FairHookHost, v4SwapRouter: BOOK.V4SwapRouter,
  token, curve, batch, poolId, launchFee: fee.toString(), deposit: DEPOSIT.toString(),
  stepCountA: phases.a.length, stepCountB: phases.b.length, stepCountC: phases.c.length,
  stepsA: encodeAbiParameters(stepType, [phases.a]),
  stepsB: encodeAbiParameters(stepType, [phases.b]),
  stepsC: encodeAbiParameters(stepType, [phases.c]),
}, null, 2) + '\n');
console.log(`wrote ${phases.a.length}+${phases.b.length}+${phases.c.length} steps; safe ${safe}, roles ${roles}, token ${token}`);
