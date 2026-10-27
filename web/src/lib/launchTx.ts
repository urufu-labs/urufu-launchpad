/// Launch transaction builders shared by the create pages and the agent API, so a
/// launch built through /api/agent/v2 or the MCP server is byte-for-byte the tx
/// the website would send for the same inputs (pinned by agentV2 parity tests).
///
/// Pure: imports only viem and the ABI file, no React or wagmi.

import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';

import { erc20TokenAbi, fairLaunchFactoryAbi, routerAbi } from './abis';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/// Bare-ERC20 configHash: `keccak256(abi.encode("ERC20", ""))`. Same value the
/// create page's `configHashFor('ERC20', [])` returns for a module-less launch.
export const QUICK_CONFIG_HASH = keccak256(
  encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['ERC20', '']),
);

/// Sniper gate for quick launches: 5 L1 blocks (~60 s on RH, where contract
/// `block.number` is the Ethereum L1 block).
export const QUICK_ANTI_SNIPER_BLOCKS = 5;

/// Fallback curve supply (800M, 18 decimals) when CurveFactory.defaultCurveSupply
/// hasn't been read yet. The create page uses the same fallback.
export const DEFAULT_CURVE_SUPPLY = 800_000_000n * 10n ** 18n;

export interface QuickLaunchParams {
  base: number;
  name: string;
  ticker: string;
  configHash: Hex;
  initData: Hex;
  moduleCount: bigint;
  installHook: boolean;
  installGovernance: boolean;
  installBondingCurve: boolean;
  ownership: number;
  ownerTargetIfMultisig: Address;
  antiSniperBlocks: number;
  buybackBurnBps: number;
}

/// LaunchParams for a quick token-lane launch (ERC-20 + bonding curve, no modules).
/// `initData = abi.encode(curveSupply, router, [])`: the Router receives the supply
/// so the curve can pull it during install.
export function buildQuickLaunchParams(args: {
  name: string;
  ticker: string;
  router: Address;
  curveSupply?: bigint;
}): QuickLaunchParams {
  const initData = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes[]' }],
    [args.curveSupply ?? DEFAULT_CURVE_SUPPLY, args.router, []],
  );
  return {
    base: 0,
    name: args.name,
    ticker: args.ticker,
    configHash: QUICK_CONFIG_HASH,
    initData,
    moduleCount: 1n,
    installHook: false,
    installGovernance: false,
    installBondingCurve: true,
    ownership: 0,
    ownerTargetIfMultisig: ZERO,
    antiSniperBlocks: QUICK_ANTI_SNIPER_BLOCKS,
    buybackBurnBps: 0,
  };
}

/// URU amount the token lane charges for an ETH fee: spot price from the URU/WETH
/// v4 pool's sqrtPriceX96, raised to the on-chain floor (`minUruFeeFor`) when the
/// spot quote is lower. Mirrors RouterV2's `uruAmount < required` gate.
export function uruAmountForEthFee(args: {
  ethFee: bigint;
  sqrtPriceX96: bigint;
  uruIsCurrency1: boolean;
  floor?: bigint;
}): bigint | undefined {
  const { ethFee, sqrtPriceX96, uruIsCurrency1, floor } = args;
  if (ethFee === 0n || sqrtPriceX96 === 0n) return undefined;
  const Q192 = 1n << 192n;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const spot = uruIsCurrency1 ? (ethFee * priceX192) / Q192 : (ethFee * Q192) / priceX192;
  if (typeof floor === 'bigint' && floor > spot) return floor;
  return spot;
}

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: bigint;
}

/// Token-lane launch. ETH pays `fee` (+ optional atomic first buy via
/// launchAndBuy, minTokensOut 0 since nothing can wedge in between); URU pays
/// `uruAmount` with no ETH attached.
export function buildTokenLaunchTx(args: {
  router: Address;
  params: QuickLaunchParams;
  payWith: 'ETH' | 'URU';
  fee: bigint;
  initialBuyWei?: bigint;
  uruAmount?: bigint;
  recipient: Address;
}): UnsignedTx {
  const { router, params, payWith, fee } = args;
  if (payWith === 'URU') {
    if (args.uruAmount === undefined) throw new Error('uruAmount required for a URU launch');
    return {
      to: router,
      data: encodeFunctionData({ abi: routerAbi, functionName: 'launchWithURU', args: [params, args.uruAmount] }),
      value: 0n,
    };
  }
  const buy = args.initialBuyWei ?? 0n;
  if (buy > 0n) {
    return {
      to: router,
      data: encodeFunctionData({ abi: routerAbi, functionName: 'launchAndBuy', args: [params, buy, 0n, args.recipient] }),
      value: fee + buy,
    };
  }
  return {
    to: router,
    data: encodeFunctionData({ abi: routerAbi, functionName: 'launch', args: [params] }),
    value: fee,
  };
}

/// Fair-lane launch. ETH: `launch(name, symbol)` with fee + opening deposit attached.
/// URU: `launchWithURU(name, symbol, fee)` with only the deposit attached.
export function buildFairLaunchTx(args: {
  factory: Address;
  name: string;
  ticker: string;
  payWith: 'ETH' | 'URU';
  fee: bigint;
  depositWei: bigint;
}): UnsignedTx {
  const { factory, name, ticker, payWith, fee, depositWei } = args;
  if (payWith === 'URU') {
    return {
      to: factory,
      data: encodeFunctionData({ abi: fairLaunchFactoryAbi, functionName: 'launchWithURU', args: [name, ticker, fee] }),
      value: depositWei,
    };
  }
  return {
    to: factory,
    data: encodeFunctionData({ abi: fairLaunchFactoryAbi, functionName: 'launch', args: [name, ticker] }),
    value: depositWei + fee,
  };
}

/// ERC-20 approve, used for the URU fee step on both lanes.
export function buildApproveTx(token: Address, spender: Address, amount: bigint): UnsignedTx {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [spender, amount] }),
    value: 0n,
  };
}
