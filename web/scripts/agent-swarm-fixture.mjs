// Writes contracts/test/agent/fixtures/agent-swarm.json: the exact calldata the agent
// API builds for a swarm run by two autonomous agent accounts (Safe + Zodiac Roles):
// create the swarm, arm both accounts, the owners allow the swarm, the agents join,
// vote, leave and rejoin, the pool joins the creator's launch, then they claim. Each step
// is marked ok / the exact policy revert. contracts/test/agent/AgentSwarmFork.t.sol
// replays it on a Robinhood fork, with the creator's launch done in Solidity.
//
// Re-run after any change to agentPolicy.ts or swarmTools.ts:
//   cd web
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     --import ./scripts/ts-resolve.mjs scripts/agent-swarm-fixture.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeFunctionResult, encodeAbiParameters, encodeErrorResult, encodeFunctionData, getContractAddress, http, parseAbi, parseEther } from 'viem';

import {
  agentExecTx, configureCalls, createSafeTx, deployRolesTx, moduleProxyFactoryAbi, safeBatchTx, safeProxyFactoryAbi, swarmPermissionCalls, swarmVaultAbi,
} from '../src/lib/agentV2/agentPolicy.ts';
import { buildCreateSwarmTx } from '../src/lib/agentV2/swarmTools.ts';
import { BOOK } from '../src/lib/agentV2/testFixtures.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'test', 'agent', 'fixtures', 'agent-swarm.json');
const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });

const OWNERS = ['0x0000000000000000000000000000000000a9e011', '0x0000000000000000000000000000000000a9e012'];
const AGENTS = ['0x0000000000000000000000000000000000a9e021', '0x0000000000000000000000000000000000a9e022'];
const OUTSIDER = '0x0000000000000000000000000000000000a9e003';
const CREATOR = '0x0000000000000000000000000000000000a9e030';
const FROM = { owner1: 0, owner2: 1, agent1: 2, agent2: 3, outsider: 4 };
const NAME = 'Agent Swarm Fork Test';
const TICKER = 'ASWF';

/// The fork test etches SwarmVaultFactory at this address; its constructor deploys the
/// vault implementation (nonce 0), so the first swarm is at nonce 1, the second at 2.
const SWARM_FACTORY = BOOK.SwarmVaultFactory;
const VAULT = getContractAddress({ from: SWARM_FACTORY, nonce: 1n });
const OTHER_VAULT = getContractAddress({ from: SWARM_FACTORY, nonce: 2n });

const rolesErrors = parseAbi(['error ConditionViolation(uint8 status, bytes32 info)']);
const violation = (status) => encodeErrorResult({ abi: rolesErrors, errorName: 'ConditionViolation', args: [status, '0x' + '00'.repeat(32)] }).slice(0, 2 + 8 + 64);
const TARGET = violation(2);
const ETHER_CAP = violation(19);

const phases = { a: [], b: [], c: [] };
const step = (phase, label, from, tx, expect, warpBefore = 0) =>
  phases[phase].push({
    label, from: FROM[from], to: tx.to, value: tx.value ?? 0n, data: tx.data ?? '0x',
    expectOk: expect === true, expectRevert: expect === true ? '0x' : expect, warpBefore: BigInt(warpBefore),
  });

const swarmParams = (name) => ({
  creator: CREATOR, name, ticker: TICKER, joinSeconds: 3600, launchSeconds: 3600, quorumBps: 6000,
  minPool: parseEther('0.1'), maxPool: 0n, minDeposit: parseEther('0.001'), metadataURI: '',
});

const accounts = [];
for (let i = 0; i < 2; i++) {
  const salt = 0x7377726dn + BigInt(i); // "swrm" + i
  const cs = createSafeTx(OWNERS[i], salt);
  const safe = decodeFunctionResult({ abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', data: (await client.call({ account: OWNERS[i], to: cs.to, data: cs.data })).data });
  const dr = deployRolesTx(safe, salt);
  const roles = decodeFunctionResult({ abi: moduleProxyFactoryAbi, functionName: 'deployModule', data: (await client.call({ account: OWNERS[i], to: dr.to, data: dr.data })).data });
  accounts.push({ owner: OWNERS[i], agent: AGENTS[i], safe, roles, cs, dr });
}

const policy = {
  tokens: [],
  v4SwapRouter: BOOK.V4SwapRouter,
  hooks: [BOOK.MultiHookHost, BOOK.LegacyMultiHookHost, BOOK.FairHookHost],
  multiHookHosts: [BOOK.MultiHookHost, BOOK.LegacyMultiHookHost],
  fairHookHost: BOOK.FairHookHost,
  fairLaunchFactory: BOOK.FairLaunchFactory,
};
const vaultCall = (fn, value = 0n, to = VAULT) => ({ to, value, data: encodeFunctionData({ abi: swarmVaultAbi, functionName: fn }) });
const asAgent = (i, inner) => agentExecTx(accounts[i].roles, inner);

// ---- A: the swarm is created, two agent accounts are set up and allowed in, they join and vote
step('a', 'outsider creates the swarm (create_swarm)', 'outsider', buildCreateSwarmTx(SWARM_FACTORY, swarmParams(NAME)), true);
step('a', 'outsider creates a second, unrelated swarm', 'outsider', buildCreateSwarmTx(SWARM_FACTORY, swarmParams('Other Swarm')), true);
for (let i = 0; i < 2; i++) {
  const a = accounts[i];
  const who = `owner${i + 1}`;
  step('a', `${who}: create Safe`, who, a.cs, true);
  step('a', `${who}: deploy Roles`, who, a.dr, true);
  step('a', `${who}: arm policy, no tokens`, who, safeBatchTx(a.safe, a.owner, configureCalls({ safe: a.safe, roles: a.roles, agent: a.agent, policy, dailyWei: parseEther('0.25'), perTradeWei: parseEther('0.05'), allowFairLaunch: false })), true);
  step('a', `${who}: fund Safe 1 ETH`, who, { to: a.safe, value: parseEther('1'), data: '0x' }, true);
}
step('a', 'agent1 joins BEFORE its owner allowed the swarm', 'agent1', asAgent(0, vaultCall('join', parseEther('0.01'))), TARGET);
for (let i = 0; i < 2; i++) {
  step('a', `owner${i + 1}: allow the swarm (allow_agent_swarm)`, `owner${i + 1}`, safeBatchTx(accounts[i].safe, accounts[i].owner, swarmPermissionCalls(accounts[i].roles, VAULT)), true);
}
step('a', 'agent1 joins with 0.05 (its per-trade cap)', 'agent1', asAgent(0, vaultCall('join', parseEther('0.05'))), true, 2);
step('a', 'agent1 joins with 0.05 ETH + 1 wei: over the per-trade cap', 'agent1', asAgent(0, vaultCall('join', parseEther('0.05') + 1n)), ETHER_CAP, 2);
step('a', 'agent1 joins the OTHER swarm, not allowed', 'agent1', asAgent(0, vaultCall('join', parseEther('0.01'), OTHER_VAULT)), TARGET, 2);
step('a', 'agent2 joins with 0.05', 'agent2', asAgent(1, vaultCall('join', parseEther('0.05'))), true, 2);
step('a', 'agent2 leaves (ETH back to its Safe)', 'agent2', asAgent(1, vaultCall('leave')), true, 2);
step('a', 'agent2 joins again with 0.05', 'agent2', asAgent(1, vaultCall('join', parseEther('0.05'))), true, 2);
step('a', 'agent1 votes yes', 'agent1', asAgent(0, vaultCall('approve')), true);
step('a', 'agent2 votes yes', 'agent2', asAgent(1, vaultCall('approve')), true);

// ---- (Solidity: past the vote, the named creator launches the coin)

// ---- B: an agent puts the pool into the opening batch
step('b', 'agent1 puts the pool into the opening batch (join_batch)', 'agent1', asAgent(0, vaultCall('joinBatch')), true);

// ---- (Solidity: others deposit, the batch window closes)

// ---- C: claim
step('c', 'agent2 collects from the batch for the swarm', 'agent2', asAgent(1, vaultCall('claimFromBatch')), true, 2);
step('c', 'agent1 takes its share into its Safe', 'agent1', asAgent(0, vaultCall('withdrawShare')), true);
step('c', 'agent2 takes its share into its Safe', 'agent2', asAgent(1, vaultCall('withdrawShare')), true);

const stepType = [{ type: 'tuple[]', components: [
  { name: 'label', type: 'string' }, { name: 'from', type: 'uint8' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' }, { name: 'expectOk', type: 'bool' }, { name: 'expectRevert', type: 'bytes' }, { name: 'warpBefore', type: 'uint64' },
] }];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  note: 'Generated by web/scripts/agent-swarm-fixture.mjs from web/src/lib/agentV2 (agentPolicy.ts, swarmTools.ts). Do not edit by hand.',
  owner1: OWNERS[0], owner2: OWNERS[1], agent1: AGENTS[0], agent2: AGENTS[1], outsider: OUTSIDER, creator: CREATOR,
  safe1: accounts[0].safe, safe2: accounts[1].safe,
  swarmFactory: SWARM_FACTORY, fairFactory: BOOK.FairLaunchFactory, vault: VAULT, otherVault: OTHER_VAULT, name: NAME, ticker: TICKER,
  stepCountA: phases.a.length, stepCountB: phases.b.length, stepCountC: phases.c.length,
  stepsA: encodeAbiParameters(stepType, [phases.a]),
  stepsB: encodeAbiParameters(stepType, [phases.b]),
  stepsC: encodeAbiParameters(stepType, [phases.c]),
}, null, 2) + '\n');
console.log(`wrote ${phases.a.length}+${phases.b.length}+${phases.c.length} steps; vault ${VAULT}, safes ${accounts[0].safe} ${accounts[1].safe}`);
