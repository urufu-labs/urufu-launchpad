// Writes contracts/test/agent/fixtures/agent-policy.json: the exact calldata that
// web/src/lib/agentV2/agentPolicy.ts builds for an agent account (Safe + Zodiac
// Roles policy) plus a scripted run of agent actions, each marked ok / revert.
// contracts/test/agent/AgentPolicyFork.t.sol replays it on a Robinhood fork.
//
// Re-run after any change to agentPolicy.ts:
//   cd web
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     --import ./scripts/ts-resolve.mjs scripts/agent-policy-fixture.mjs
//
// Reads live Robinhood only for curve / batch addresses and the Fair launch fee;
// Safe and Roles addresses come from the factories' deterministic CREATE2 (eth_call).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeFunctionResult, encodeAbiParameters, encodeErrorResult, encodeFunctionData, http, parseAbi, parseEther } from 'viem';

import { bondingCurveAbi, curveFactoryAbi, erc20TokenAbi, fairLaunchFactoryAbi, openingBatchAbi, v4SwapRouterAbi } from '../src/lib/abis.ts';
import {
  AGENT_ROLE_KEY, agentExecTx, configureCalls, createSafeTx, deployRolesTx, moduleProxyFactoryAbi, rolesAbi,
  safeBatchTx, safeProxyFactoryAbi, tokenPermissionCalls,
} from '../src/lib/agentV2/agentPolicy.ts';
import { BOOK } from '../src/lib/agentV2/testFixtures.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'test', 'agent', 'fixtures', 'agent-policy.json');
const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });

// Test actors: fixed addresses the fork test funds with vm.deal and pranks as.
const OWNER = '0x0000000000000000000000000000000000a9e001';
const AGENT = '0x0000000000000000000000000000000000a9e002';
const OUTSIDER = '0x0000000000000000000000000000000000a9e003';
const FROM = { owner: 0, agent: 1, outsider: 2 };

const CURVE_TOKEN = '0x286ee43fdeb6f2a8ee06823a7f3b0d11aebf4223';
const POOL_TOKEN = '0x2c0a57ef2698a881cda6f5106fa6748fa4713a81';
const OTHER_TOKEN = '0x803b95cf1db535089b31eb24c268e0a57b6ef29c';
const FAR_DEADLINE = 2n ** 40n;
const SALT = 0x75727566n; // "uruf"

const curveOf = (t) => client.readContract({ address: BOOK.CurveFactory, abi: curveFactoryAbi, functionName: 'curveFor', args: [t] });

const steps = [];
/// `expect` is true (must succeed) or the exact revert the POLICY must give, so a
/// forbidden step can't pass by failing for some unrelated reason.
const step = (label, from, tx, expect, warpBefore = 0) =>
  steps.push({
    label, from: FROM[from], to: tx.to, value: tx.value ?? 0n, data: tx.data ?? '0x',
    expectOk: expect === true, expectRevert: expect === true ? '0x' : expect, warpBefore: BigInt(warpBefore),
  });

// Roles v2.1.0 errors (PermissionChecker.Status codes).
const rolesErrors = parseAbi(['error ConditionViolation(uint8 status, bytes32 info)', 'error NotAuthorized(address module)', 'error NoMembership()', 'error OwnableUnauthorizedAccount(address account)']);
const violation = (status) => encodeErrorResult({ abi: rolesErrors, errorName: 'ConditionViolation', args: [status, '0x' + '00'.repeat(32)] }).slice(0, 2 + 8 + 64);
const DELEGATECALL = violation(1);
const TARGET = violation(2);
const OR = violation(5);
const PARAM = violation(7);
const ETHER_CAP = violation(19);
/// Never a member (outsider) vs. removed from the role (agent after revoke).
const notMember = (who) => encodeErrorResult({ abi: rolesErrors, errorName: 'NotAuthorized', args: [who] });
const REVOKED = encodeErrorResult({ abi: rolesErrors, errorName: 'NoMembership' });

const curveToken = { token: CURVE_TOKEN, curve: await curveOf(CURVE_TOKEN), batch: null };
const poolToken = { token: POOL_TOKEN, curve: await curveOf(POOL_TOKEN), batch: null };
const otherCurve = await curveOf(OTHER_TOKEN);

const cs = createSafeTx(OWNER, SALT);
const safe = decodeFunctionResult({ abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', data: (await client.call({ account: OWNER, to: cs.to, data: cs.data })).data });
const dr = deployRolesTx(safe, SALT);
const roles = decodeFunctionResult({ abi: moduleProxyFactoryAbi, functionName: 'deployModule', data: (await client.call({ account: OWNER, to: dr.to, data: dr.data })).data });

const policy = {
  tokens: [curveToken, poolToken],
  v4SwapRouter: BOOK.V4SwapRouter,
  hooks: [BOOK.MultiHookHost, BOOK.LegacyMultiHookHost, BOOK.FairHookHost],
  multiHookHosts: [BOOK.MultiHookHost, BOOK.LegacyMultiHookHost],
  fairHookHost: BOOK.FairHookHost,
  fairLaunchFactory: BOOK.FairLaunchFactory,
};

const asAgent = (inner) => agentExecTx(roles, inner);
const buy = (curve, ethIn) => ({ to: curve, value: ethIn, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: 'buy', args: [0n] }) });
const swapKey = (over = {}) => ({ currency0: '0x0000000000000000000000000000000000000000', currency1: POOL_TOKEN, fee: 3000, tickSpacing: 60, hooks: BOOK.MultiHookHost, ...over });
const swap = (key, recipient) => ({ to: BOOK.V4SwapRouter, value: parseEther('0.01'), data: encodeFunctionData({ abi: v4SwapRouterAbi, functionName: 'swapExactETHForToken', args: [key, 1n, recipient, FAR_DEADLINE] }) });

// ---- setup: three owner txs + funding
step('create Safe', 'owner', cs, true);
step('deploy Roles', 'owner', dr, true);
step('arm policy (one Safe tx)', 'owner', safeBatchTx(safe, OWNER, configureCalls({ safe, roles, agent: AGENT, policy, dailyWei: parseEther('0.25'), perTradeWei: parseEther('0.05'), allowFairLaunch: false })), true);
step('fund Safe 2 ETH', 'owner', { to: safe, value: parseEther('2'), data: '0x' }, true);

// ---- caps
step('buy 0.01 on allowlisted curve', 'agent', asAgent(buy(curveToken.curve, parseEther('0.01'))), true, 2);
step('buy exactly 0.05 (per-trade cap)', 'agent', asAgent(buy(curveToken.curve, parseEther('0.05'))), true, 2);
step('buy 0.05 ETH + 1 wei', 'agent', asAgent(buy(curveToken.curve, parseEther('0.05') + 1n)), ETHER_CAP, 2);
for (const amt of ['0.05', '0.05', '0.05', '0.04']) step(`buy ${amt} toward the daily cap`, 'agent', asAgent(buy(curveToken.curve, parseEther(amt))), true, 2);
step('buy 0.001 over the 0.25 daily cap', 'agent', asAgent(buy(curveToken.curve, parseEther('0.001'))), ETHER_CAP, 2);
step('next day: buy 0.01', 'agent', asAgent(buy(curveToken.curve, parseEther('0.01'))), true, 86_400);

// ---- allowlist
step('ETH to an EOA', 'agent', asAgent({ to: OUTSIDER, value: parseEther('0.01'), data: '0x' }), TARGET, 2);
step('buy on a non-allowlisted curve', 'agent', asAgent(buy(otherCurve, parseEther('0.01'))), TARGET, 2);
step('call a non-allowlisted contract', 'agent', asAgent({ to: BOOK.Router, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function paused() view returns (bool)']), functionName: 'paused' }) }), TARGET);
step('approve token to an outsider', 'agent', asAgent({ to: CURVE_TOKEN, value: 0n, data: encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [OUTSIDER, parseEther('1000')] }) }), OR);
step('approve token to its curve', 'agent', asAgent({ to: CURVE_TOKEN, value: 0n, data: encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [curveToken.curve, parseEther('1000')] }) }), true);
step('sell 1000 tokens on the curve', 'agent', asAgent({ to: curveToken.curve, value: 0n, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: 'sell', args: [parseEther('1000'), 0n] }) }), true);

// ---- v4 swaps
step('v4 buy with recipient = agent', 'agent', asAgent(swap(swapKey(), AGENT)), PARAM, 2);
step('v4 buy on a foreign hook', 'agent', asAgent(swap(swapKey({ hooks: '0x1111111111111111111111111111111111111111' }), safe)), OR);
step('v4 buy on another fee tier', 'agent', asAgent(swap(swapKey({ fee: 10000 }), safe)), PARAM);
step('v4 buy 0.01, recipient = Safe', 'agent', asAgent(swap(swapKey(), safe)), true);

// ---- privilege
const inner = buy(curveToken.curve, parseEther('0.001'));
step('delegatecall through the role', 'agent', { to: roles, value: 0n, data: encodeFunctionData({ abi: rolesAbi, functionName: 'execTransactionWithRole', args: [inner.to, inner.value, inner.data, 1, AGENT_ROLE_KEY, true] }) }, DELEGATECALL, 2);
step('agent edits the policy directly', 'agent', { to: roles, value: 0n, data: encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [OUTSIDER, [AGENT_ROLE_KEY], [true]] }) }, encodeErrorResult({ abi: rolesErrors, errorName: 'OwnableUnauthorizedAccount', args: [AGENT] }));
step('agent raises its own cap via the Safe', 'agent', asAgent({ to: roles, value: 0n, data: encodeFunctionData({ abi: rolesAbi, functionName: 'setAllowance', args: [AGENT_ROLE_KEY, 10n ** 30n, 10n ** 30n, 10n ** 30n, 1n, 0n] }) }), TARGET);
step('outsider uses the role', 'outsider', asAgent(inner), notMember(OUTSIDER));

// ---- Fair opening batch, added to the policy later by the owner
const fairName = 'Agent Policy Fork Test';
const fee = await client.readContract({ address: BOOK.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'ethFeeFor', args: [OUTSIDER] });
const [fToken, fCurve, fBatch] = await client.readContract({ address: BOOK.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'predictAddresses', args: [OUTSIDER, fairName, 'APFT'] });
step('outsider launches a Fair token', 'outsider', { to: BOOK.FairLaunchFactory, value: fee, data: encodeFunctionData({ abi: fairLaunchFactoryAbi, functionName: 'launch', args: [fairName, 'APFT'] }) }, true);
step('owner adds the Fair token (one Safe tx)', 'owner', safeBatchTx(safe, OWNER, tokenPermissionCalls(roles, policy, { token: fToken, curve: fCurve, batch: fBatch })), true);
step('batch deposit over the per-trade cap', 'agent', asAgent({ to: fBatch, value: parseEther('0.05') + 1n, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'deposit' }) }), ETHER_CAP, 2);
step('batch deposit 0.02', 'agent', asAgent({ to: fBatch, value: parseEther('0.02'), data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'deposit' }) }), true);
step('withdrawRefund to the agent', 'agent', asAgent({ to: fBatch, value: 0n, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'withdrawRefund', args: [AGENT] }) }), PARAM);
step('settle the batch', 'agent', asAgent({ to: fBatch, value: 0n, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'settle' }) }), true, 120);
step('claim batch tokens to the Safe', 'agent', asAgent({ to: fBatch, value: 0n, data: encodeFunctionData({ abi: openingBatchAbi, functionName: 'claim' }) }), true);

// ---- revoke
step('owner revokes the agent', 'owner', safeBatchTx(safe, OWNER, [{ to: roles, value: 0n, data: encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [AGENT, [AGENT_ROLE_KEY], [false]] }) }]), true);
step('agent buys after revoke', 'agent', asAgent(buy(curveToken.curve, parseEther('0.001'))), REVOKED, 2);

const encodedSteps = encodeAbiParameters(
  [{ type: 'tuple[]', components: [
    { name: 'label', type: 'string' }, { name: 'from', type: 'uint8' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'expectOk', type: 'bool' }, { name: 'expectRevert', type: 'bytes' }, { name: 'warpBefore', type: 'uint64' },
  ] }],
  [steps],
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  note: 'Generated by web/scripts/agent-policy-fixture.mjs from web/src/lib/agentV2/agentPolicy.ts. Do not edit by hand.',
  owner: OWNER, agent: AGENT, outsider: OUTSIDER, safe, roles,
  curveToken: CURVE_TOKEN, poolToken: POOL_TOKEN, fairToken: fToken, fairBatch: fBatch,
  stepCount: steps.length,
  steps: encodedSteps,
}, null, 2) + '\n');
console.log(`wrote ${steps.length} steps; safe ${safe}, roles ${roles}`);
