/// Autonomous-mode agent accounts (phase 1c, docs/PLAN-agents-and-swarms.md 2.4).
///
/// The agent's funds sit in a Safe 1.4.1 owned by the human. The agent key is not
/// a Safe owner: it is the only member of one Zodiac Roles v2.1.0 role attached to
/// the Safe as a module. The role is the whole policy, enforced on chain:
///
///   - only these calls, nothing else (no ETH transfers, no delegatecall):
///       bonding curve buy and sell, and token approve (spender = that curve or
///       the V4SwapRouter), per listed token;
///       Fair opening batch deposit / settle / claim / withdrawRefund(to = Safe);
///       V4SwapRouter swaps on ETH/<listed token> 3000/60 pools at urufu hooks
///       only, with the recipient pinned to the Safe;
///       creator fee claims (MultiHookHost claim(ETH), FairHookHost claim);
///       optionally FairLaunchFactory.launch (phase 2 agent tokens).
///   - ETH sent by any allowed call is drawn from two allowances, both enforced:
///       DAILY  refills `daily` every 24 h (default 0.25 ETH);
///       TRADE  refills `perTrade` every second (default 0.05 ETH), so one call
///              can never spend more than `perTrade`.
///   - tokens leaving by sale are capped too: each listed token has its own daily
///     sell allowance (token units, curve and v4 together), so a hostile agent
///     can't dump the Safe's whole balance into a sandwich it set up. Within the
///     caps the agent can still trade badly; the caps bound how fast, not how well.
///   - the owner revokes the agent (or the whole module) with one Safe tx.
///
/// Nothing here deploys anything or holds a key: these are calldata builders for
/// the owner's and the agent's own wallets. Verified against a Robinhood fork in
/// agentPolicy.fork.test.mjs.

import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAbiItem,
  numberToHex,
  parseAbi,
  size,
  stringToHex,
  keccak256,
  toBytes,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';

import { bondingCurveAbi, erc20TokenAbi, fairHookHostAbi, fairLaunchFactoryAbi, multiHookHostAbi, openingBatchAbi, v4SwapRouterAbi } from '../abis';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/// Canonical deployments, all checked for code on Robinhood (chain 4663).
export const AGENT_ACCOUNT_CONTRACTS = {
  SafeL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as Address,
  SafeProxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as Address,
  SafeFallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' as Address,
  MultiSendCallOnly: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2' as Address,
  /// Zodiac Roles Modifier v2.1.0 mastercopy + ModuleProxyFactory.
  RolesMastercopy: '0x9646fDAD06d3e24444381f44362a3B0eB343D337' as Address,
  ModuleProxyFactory: '0x000000000000aDdB49795b0f9bA5BC298cDda236' as Address,
} as const;

export const AGENT_ROLE_KEY: Hex = stringToHex('urufu-agent', { size: 32 });
export const ALLOWANCE_DAILY: Hex = stringToHex('urufu-agent-daily', { size: 32 });
export const ALLOWANCE_TRADE: Hex = stringToHex('urufu-agent-trade', { size: 32 });

export const DEFAULT_DAILY_WEI = 250_000_000_000_000_000n; // 0.25 ETH
export const DEFAULT_PER_TRADE_WEI = 50_000_000_000_000_000n; // 0.05 ETH

export const safeAbi = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]);
export const safeProxyFactoryAbi = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
]);
export const moduleProxyFactoryAbi = parseAbi([
  'function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)',
]);
export const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable']);
export const rolesAbi = parseAbi([
  'struct ConditionFlat { uint8 parent; uint8 paramType; uint8 operator; bytes compValue; }',
  'function setUp(bytes initParams)',
  'function owner() view returns (address)',
  'function avatar() view returns (address)',
  'function target() view returns (address)',
  'function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
  'function setDefaultRole(address module, bytes32 roleKey)',
  'function scopeTarget(bytes32 roleKey, address targetAddress)',
  'function revokeTarget(bytes32 roleKey, address targetAddress)',
  'function revokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector)',
  'function allowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)',
  'function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, ConditionFlat[] conditions, uint8 options)',
  'function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)',
  'function allowances(bytes32 key) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)',
  'function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool success)',
]);

// ---------------------------------------------------------------- conditions

/// Roles v2 enums (contracts/Types.sol).
const P = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5, AbiEncoded: 6 } as const;
const O = { Pass: 0, And: 1, Or: 2, Matches: 5, EqualToAvatar: 15, EqualTo: 16, WithinAllowance: 28, EtherWithinAllowance: 29 } as const;
/// ExecutionOptions: None = plain call, no ETH; Send = may carry ETH. Never DelegateCall.
export const EXEC = { None: 0, Send: 1 } as const;

interface Cond {
  paramType: number;
  operator: number;
  compValue?: Hex;
  children?: Cond[];
}

const pass = (): Cond => ({ paramType: P.Static, operator: O.Pass });
const passDynamic = (): Cond => ({ paramType: P.Dynamic, operator: O.Pass });
const isAvatar = (): Cond => ({ paramType: P.Static, operator: O.EqualToAvatar });
const eqAddress = (a: Address): Cond => ({ paramType: P.Static, operator: O.EqualTo, compValue: encodeAbiParameters([{ type: 'address' }], [a]) });
const eqUint = (n: bigint): Cond => ({ paramType: P.Static, operator: O.EqualTo, compValue: encodeAbiParameters([{ type: 'uint256' }], [n]) });
const eqInt = (n: bigint): Cond => ({ paramType: P.Static, operator: O.EqualTo, compValue: encodeAbiParameters([{ type: 'int256' }], [n]) });
const oneOfAddress = (as: Address[]): Cond => (as.length === 1 ? eqAddress(as[0]!) : { paramType: P.None, operator: O.Or, children: as.map(eqAddress) });
const etherAllowance = (key: Hex): Cond => ({ paramType: P.None, operator: O.EtherWithinAllowance, compValue: key });
/// Draws the parameter's value (a token amount) from `key`'s allowance.
const withinAllowance = (key: Hex): Cond => ({ paramType: P.Static, operator: O.WithinAllowance, compValue: key });
const anyOf = (branches: Cond[]): Cond => (branches.length === 1 ? branches[0]! : { paramType: P.None, operator: O.Or, children: branches });

/// Per-token daily sell allowance key (token units, shared by curve and v4 sells).
export function sellAllowanceKey(token: Address): Hex {
  return keccak256(toBytes(`urufu-agent-sell:${token.toLowerCase()}`));
}

/// Root node for a function's calldata. Payable calls get both ETH allowances.
function calldata(params: Cond[], payable: boolean): Cond {
  return {
    paramType: P.Calldata,
    operator: O.Matches,
    children: payable ? [...params, etherAllowance(ALLOWANCE_DAILY), etherAllowance(ALLOWANCE_TRADE)] : params,
  };
}

/// Breadth-first flattening required by Roles v2 (parents non-decreasing).
export function flatten(root: Cond): Array<{ parent: number; paramType: number; operator: number; compValue: Hex }> {
  const out: Array<{ parent: number; paramType: number; operator: number; compValue: Hex }> = [];
  const queue: Array<{ c: Cond; parent: number }> = [{ c: root, parent: 0 }];
  while (queue.length) {
    const { c, parent } = queue.shift()!;
    const idx = out.length;
    out.push({ parent, paramType: c.paramType, operator: c.operator, compValue: c.compValue ?? '0x' });
    for (const ch of c.children ?? []) queue.push({ c: ch, parent: idx });
  }
  return out;
}

/// ETH/`token` pool key at one of urufu's hooks, fixed graduation shape.
function poolKeyCond(hooks: Address[], token: Address): Cond {
  return {
    paramType: P.Tuple,
    operator: O.Matches,
    children: [eqAddress(ZERO), eqAddress(token), eqUint(3000n), eqInt(60n), oneOfAddress(hooks)],
  };
}

// ---------------------------------------------------------------- policy

export interface PolicyTokens {
  token: Address;
  curve: Address;
  /// Fair lane opening batch, when the token is a Fair launch.
  batch: Address | null;
  /// Most of this token (in base units) the agent may sell per 24 h, on the
  /// curve and the v4 pool together. 0 = the agent can't sell it at all. Without
  /// this a hostile agent could dump the Safe's whole balance into a sandwich.
  dailySellTokens: bigint;
}

export interface PolicyInput {
  tokens: PolicyTokens[];
  v4SwapRouter: Address;
  /// urufu pool hooks a swap may touch (current MHH, legacy V10 MHH, FairHookHost).
  hooks: Address[];
  multiHookHosts: Address[];
  fairHookHost: Address;
  fairLaunchFactory: Address | null;
}

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

const sel = (abi: Abi, name: string): Hex => toFunctionSelector(getAbiItem({ abi, name }) as AbiFunction);

const rolesCall = (roles: Address, functionName: string, args: unknown[]): Call => ({
  to: roles,
  value: 0n,
  data: encodeFunctionData({ abi: rolesAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]),
});

function scope(roles: Address, target: Address, selector: Hex, root: Cond, options: number): Call {
  return rolesCall(roles, 'scopeFunction', [AGENT_ROLE_KEY, target, selector, flatten(root), options]);
}

/// Every Roles call that grants the per-token permissions for `t` (curve buy,
/// capped sells, approve, Fair batch). v4 swaps are in routerPermissionCalls.
export function tokenPermissionCalls(roles: Address, p: PolicyInput, t: PolicyTokens): Call[] {
  const key = sellAllowanceKey(t.token);
  const calls: Call[] = [
    rolesCall(roles, 'scopeTarget', [AGENT_ROLE_KEY, t.curve]),
    scope(roles, t.curve, sel(bondingCurveAbi, 'buy'), calldata([pass()], true), EXEC.Send),
    rolesCall(roles, 'scopeTarget', [AGENT_ROLE_KEY, t.token]),
  ];
  if (t.dailySellTokens > 0n) {
    const cap = t.dailySellTokens;
    calls.push(
      rolesCall(roles, 'setAllowance', [key, cap, cap, cap, 86_400n, 0n]),
      scope(roles, t.curve, sel(bondingCurveAbi, 'sell'), calldata([withinAllowance(key), pass()], false), EXEC.None),
      scope(roles, t.token, sel(erc20TokenAbi, 'approve'), calldata([oneOfAddress([t.curve, p.v4SwapRouter]), pass()], false), EXEC.None),
    );
  } else {
    calls.push(
      rolesCall(roles, 'revokeFunction', [AGENT_ROLE_KEY, t.curve, sel(bondingCurveAbi, 'sell')]),
      rolesCall(roles, 'revokeFunction', [AGENT_ROLE_KEY, t.token, sel(erc20TokenAbi, 'approve')]),
    );
  }
  if (t.batch) {
    calls.push(
      rolesCall(roles, 'scopeTarget', [AGENT_ROLE_KEY, t.batch]),
      scope(roles, t.batch, sel(openingBatchAbi, 'deposit'), calldata([], true), EXEC.Send),
      rolesCall(roles, 'allowFunction', [AGENT_ROLE_KEY, t.batch, sel(openingBatchAbi, 'settle'), EXEC.None]),
      rolesCall(roles, 'allowFunction', [AGENT_ROLE_KEY, t.batch, sel(openingBatchAbi, 'claim'), EXEC.None]),
      scope(roles, t.batch, sel(openingBatchAbi, 'withdrawRefund'), calldata([isAvatar()], false), EXEC.None),
    );
  }
  return calls;
}

/// Undo a token's grants (the owner removes it from the list).
export function removeTokenCalls(roles: Address, t: { token: Address; curve: Address; batch: Address | null }): Call[] {
  return [t.curve, t.token, ...(t.batch ? [t.batch] : [])].map((a) => rolesCall(roles, 'revokeTarget', [AGENT_ROLE_KEY, a]));
}

/// v4 swaps through the V4SwapRouter, one branch per listed token: the pool must be
/// ETH/that token at an urufu hook, the recipient the Safe, buys within the ETH
/// caps, sells within that token's sell allowance. Rewritten whole from the full
/// token list on every change, so `p.tokens` must be the complete list.
export function routerPermissionCalls(roles: Address, p: PolicyInput): Call[] {
  if (p.tokens.length === 0) return [rolesCall(roles, 'revokeTarget', [AGENT_ROLE_KEY, p.v4SwapRouter])];
  const sellSel = sel(v4SwapRouterAbi, 'swapExactTokenForETH');
  const sellers = p.tokens.filter((t) => t.dailySellTokens > 0n);
  const calls: Call[] = routerBuyPermissionCalls(roles, p, p.tokens.map((t) => t.token));
  if (sellers.length > 0) {
    const sell = anyOf(sellers.map((t) => calldata([poolKeyCond(p.hooks, t.token), withinAllowance(sellAllowanceKey(t.token)), pass(), isAvatar(), pass()], false)));
    calls.push(scope(roles, p.v4SwapRouter, sellSel, sell, EXEC.None));
  } else {
    calls.push(rolesCall(roles, 'revokeFunction', [AGENT_ROLE_KEY, p.v4SwapRouter, sellSel]));
  }
  return calls;
}

/// Only the v4 BUY scope, rebuilt from the full token list. Buys don't depend on
/// any token's sell setting, so this can be rewritten without knowing them (the
/// agent-token launch uses it; the sell scope is left as it was).
export function routerBuyPermissionCalls(roles: Address, p: PolicyInput, tokens: Address[]): Call[] {
  const buy = anyOf(tokens.map((t) => calldata([poolKeyCond(p.hooks, t), pass(), isAvatar(), pass()], true)));
  return [
    rolesCall(roles, 'scopeTarget', [AGENT_ROLE_KEY, p.v4SwapRouter]),
    scope(roles, p.v4SwapRouter, sel(v4SwapRouterAbi, 'swapExactETHForToken'), buy, EXEC.Send),
  ];
}

/// Phase 2 agent token (docs/PLAN-agents-and-swarms.md 3): the Safe launches its own
/// Fair token, and in the same Safe tx the token is listed for the agent with
/// selling OFF. The Fair lane burns the creator fee for good once the creator's
/// balance falls more than forfeitDropBps below its graduation baseline (and a
/// curve sell by the launcher forfeits it from the start), so the agent may buy,
/// deposit into the batch, claim and claim fees, but never sell, approve or move
/// the token. `listed` is every token already on the agent's list.
export function agentTokenLaunchCalls(args: {
  roles: Address;
  policy: Omit<PolicyInput, 'tokens'>;
  launch: Call[];
  own: { token: Address; curve: Address; batch: Address };
  listed: Address[];
}): Call[] {
  const { roles, policy, own } = args;
  const p: PolicyInput = { ...policy, tokens: [] };
  const ownToken: PolicyTokens = { ...own, dailySellTokens: 0n };
  const tokens = [...args.listed.filter((t) => t.toLowerCase() !== own.token.toLowerCase()), own.token];
  return [...args.launch, ...tokenPermissionCalls(roles, p, ownToken), ...routerBuyPermissionCalls(roles, p, tokens)];
}

/// Permissions that don't depend on a token: fee claims, optional Fair launch.
export function basePermissionCalls(roles: Address, p: PolicyInput, allowFairLaunch: boolean): Call[] {
  const calls: Call[] = [
    rolesCall(roles, 'scopeTarget', [AGENT_ROLE_KEY, p.fairHookHost]),
    rolesCall(roles, 'allowFunction', [AGENT_ROLE_KEY, p.fairHookHost, sel(fairHookHostAbi, 'claimCreatorFees'), EXEC.None]),
  ];
  for (const mhh of p.multiHookHosts) {
    calls.push(
      rolesCall(roles, 'scopeTarget', [AGENT_ROLE_KEY, mhh]),
      scope(roles, mhh, sel(multiHookHostAbi, 'claim'), calldata([eqAddress(ZERO)], false), EXEC.None),
    );
  }
  if (allowFairLaunch && p.fairLaunchFactory) {
    calls.push(
      rolesCall(roles, 'scopeTarget', [AGENT_ROLE_KEY, p.fairLaunchFactory]),
      scope(roles, p.fairLaunchFactory, sel(fairLaunchFactoryAbi, 'launch'), calldata([passDynamic(), passDynamic()], true), EXEC.Send),
    );
  }
  return calls;
}

// ---------------------------------------------------------------- swarms (phase 3)

/// SwarmVault (contracts/src/swarm/SwarmVault.sol), the calls a member makes.
export const swarmVaultAbi = parseAbi([
  'function join() payable',
  'function approve()',
  'function unapprove()',
  'function leave()',
  'function joinBatch()',
  'function claimFromBatch()',
  'function withdrawShare() returns (uint256 tokens, uint256 eth)',
]);

/// Let the agent take part in ONE swarm the owner chose. Every vault call pays out to
/// msg.sender (the Safe) or to nobody, so no recipient pinning is needed: `join` sends
/// ETH within both ETH allowances; voting, `leave` (ETH back to the Safe), `joinBatch`,
/// `claimFromBatch` and `withdrawShare` (tokens + ETH to the Safe) send none. The swarm's
/// token lands in the Safe and can't be sold unless the owner also lists it.
export function swarmPermissionCalls(roles: Address, vault: Address): Call[] {
  const plain = ['approve', 'unapprove', 'leave', 'joinBatch', 'claimFromBatch', 'withdrawShare'].map((fn) =>
    rolesCall(roles, 'allowFunction', [AGENT_ROLE_KEY, vault, sel(swarmVaultAbi, fn), EXEC.None]),
  );
  return [
    rolesCall(roles, 'scopeTarget', [AGENT_ROLE_KEY, vault]),
    scope(roles, vault, sel(swarmVaultAbi, 'join'), calldata([], true), EXEC.Send),
    ...plain,
  ];
}

/// Revokes the vault and each function scope on it, so a later scopeTarget alone
/// could never bring the old grants back.
export function removeSwarmCalls(roles: Address, vault: Address): Call[] {
  const fns = ['join', 'approve', 'unapprove', 'leave', 'joinBatch', 'claimFromBatch', 'withdrawShare'];
  return [
    rolesCall(roles, 'revokeTarget', [AGENT_ROLE_KEY, vault]),
    ...fns.map((fn) => rolesCall(roles, 'revokeFunction', [AGENT_ROLE_KEY, vault, sel(swarmVaultAbi, fn)])),
  ];
}

export function allowanceCalls(roles: Address, dailyWei: bigint, perTradeWei: bigint): Call[] {
  return [
    rolesCall(roles, 'setAllowance', [ALLOWANCE_DAILY, dailyWei, dailyWei, dailyWei, 86_400n, 0n]),
    rolesCall(roles, 'setAllowance', [ALLOWANCE_TRADE, perTradeWei, perTradeWei, perTradeWei, 1n, 0n]),
  ];
}

// ---------------------------------------------------------------- Safe plumbing

/// MultiSendCallOnly packing: op(uint8)=0, to, value, dataLength, data.
export function multiSendData(calls: Call[]): Hex {
  const packed = concatHex(calls.map((c) => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, c.to, c.value, BigInt(size(c.data)), c.data])));
  return encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [packed] });
}

/// Safe 1.4.1 "approved by sender" signature: r = owner, s = 0, v = 1. Valid only
/// when the tx is sent by that owner, which is exactly how these txs are used.
export function ownerSenderSignature(owner: Address): Hex {
  return concatHex([numberToHex(BigInt(owner), { size: 32 }), numberToHex(0n, { size: 32 }), '0x01']);
}

/// Owner-sent Safe tx that delegatecalls MultiSendCallOnly with `calls`.
export function safeBatchTx(safe: Address, owner: Address, calls: Call[]): Call {
  return {
    to: safe,
    value: 0n,
    data: encodeFunctionData({
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [AGENT_ACCOUNT_CONTRACTS.MultiSendCallOnly, 0n, multiSendData(calls), 1, 0n, 0n, 0n, ZERO, ZERO, ownerSenderSignature(owner)],
    }),
  };
}

export function safeInitializer(owner: Address): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [[owner], 1n, ZERO, '0x', AGENT_ACCOUNT_CONTRACTS.SafeFallbackHandler, ZERO, 0n, ZERO],
  });
}

export function createSafeTx(owner: Address, saltNonce: bigint): Call {
  return {
    to: AGENT_ACCOUNT_CONTRACTS.SafeProxyFactory,
    value: 0n,
    data: encodeFunctionData({ abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', args: [AGENT_ACCOUNT_CONTRACTS.SafeL2, safeInitializer(owner), saltNonce] }),
  };
}

/// Roles owned by the Safe, acting on the Safe: only the Safe (i.e. the human
/// owner) can change the policy.
export function deployRolesTx(safe: Address, saltNonce: bigint): Call {
  const initializer = encodeFunctionData({
    abi: rolesAbi,
    functionName: 'setUp',
    args: [encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [safe, safe, safe])],
  });
  return {
    to: AGENT_ACCOUNT_CONTRACTS.ModuleProxyFactory,
    value: 0n,
    data: encodeFunctionData({ abi: moduleProxyFactoryAbi, functionName: 'deployModule', args: [AGENT_ACCOUNT_CONTRACTS.RolesMastercopy, initializer, saltNonce] }),
  };
}

/// Everything the Safe does once to arm the agent: enable the module, grant the
/// role to the agent key, set the caps, write every permission.
export function configureCalls(args: {
  safe: Address;
  roles: Address;
  agent: Address;
  policy: PolicyInput;
  dailyWei: bigint;
  perTradeWei: bigint;
  allowFairLaunch: boolean;
}): Call[] {
  const { safe, roles, agent, policy } = args;
  return [
    { to: safe, value: 0n, data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [roles] }) },
    rolesCall(roles, 'assignRoles', [agent, [AGENT_ROLE_KEY], [true]]),
    ...allowanceCalls(roles, args.dailyWei, args.perTradeWei),
    ...basePermissionCalls(roles, policy, args.allowFairLaunch),
    ...policy.tokens.flatMap((t) => tokenPermissionCalls(roles, policy, t)),
    ...routerPermissionCalls(roles, policy),
  ];
}

/// The agent's own tx: run `inner` from the Safe through the role.
export function agentExecTx(roles: Address, inner: Call): Call {
  return {
    to: roles,
    value: 0n,
    data: encodeFunctionData({ abi: rolesAbi, functionName: 'execTransactionWithRole', args: [inner.to, inner.value, inner.data, 0, AGENT_ROLE_KEY, true] }),
  };
}
