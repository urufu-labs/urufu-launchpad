import { parseAbi } from 'viem';

/// Solidity BaseType enum → uint8 for on-chain calls.
export const BASE_TYPE = {
  ERC20: 0,
  ERC721A: 1,
  ERC1155: 2,
} as const;

/// Solidity OwnershipMode enum → uint8.
export const OWNERSHIP_MODE = {
  Renounce: 0,
  TransferToMultisig: 1,
  KeepEOA: 2,
} as const;

/// LaunchParams struct tuple type — kept as a shared reference for typed args.
export const LAUNCH_PARAMS_TUPLE = '(uint8 base, string name, string ticker, bytes32 configHash, bytes initData, uint256 moduleCount, bool installHook, bool installGovernance, bool installBondingCurve, uint8 ownership, address ownerTargetIfMultisig)' as const;

export const RESERVATION_TUPLE = '(address token, address launchedBy, uint64 timestamp, uint32 chainId, string name, string ticker)' as const;

export const nameRegistryAbi = parseAbi([
  `struct Reservation { address token; address launchedBy; uint64 timestamp; uint32 chainId; string name; string ticker; }`,
  `function isNameAvailable(string name) view returns (bool)`,
  `function isTickerAvailable(string ticker) view returns (bool)`,
  `function validateName(string name) view returns (bool valid, uint8 reason)`,
  `function validateTicker(string ticker) view returns (bool valid, uint8 reason)`,
  `function reservationOf(bytes32 nameHash) view returns (Reservation)`,
  `function tickerOwner(bytes32 tickerHash) view returns (address)`,
  `function isTickerReserved(bytes32 tickerHash) view returns (bool)`,
  `function router() view returns (address)`,
  `function treasury() view returns (address)`,
  `event Reserved(bytes32 indexed nameHash, bytes32 indexed tickerHash, address indexed token, address launchedBy, string name, string ticker, uint256 timestamp, uint256 chainId)`,
] as const);

export const routerAbi = parseAbi([
  `struct LaunchParams { uint8 base; string name; string ticker; bytes32 configHash; bytes initData; uint256 moduleCount; bool installHook; bool installGovernance; bool installBondingCurve; uint8 ownership; address ownerTargetIfMultisig; }`,
  `function quote(LaunchParams params) view returns (uint256)`,
  `function launch(LaunchParams params) payable returns (address token)`,
  `function fees(uint8 base) view returns (uint256)`,
  `function moduleAddOnFee() view returns (uint256)`,
  `function hookAddOnFee() view returns (uint256)`,
  `function governanceAddOnFee() view returns (uint256)`,
  `function paused() view returns (bool)`,
  `function factories(uint8 base) view returns (address)`,
  `event Launched(address indexed token, address indexed launchedBy, uint8 indexed base, bytes32 nameHash, bytes32 tickerHash, uint256 feePaid, bool installedHook, bool installedGovernance)`,
] as const);

export const erc20FactoryAbi = parseAbi([
  `function implFor(bytes32 configHash) view returns (address)`,
  `function predictAddress(address launcher, string name, string ticker, bytes32 configHash) view returns (address)`,
  `function usageCount(bytes32 configHash) view returns (uint256)`,
] as const);

export const erc20TokenAbi = parseAbi([
  `function name() view returns (string)`,
  `function symbol() view returns (string)`,
  `function decimals() view returns (uint8)`,
  `function totalSupply() view returns (uint256)`,
  `function balanceOf(address account) view returns (uint256)`,
  `function owner() view returns (address)`,
  `function approve(address spender, uint256 amount) returns (bool)`,
  `function allowance(address owner, address spender) view returns (uint256)`,
] as const);

export const bondingCurveAbi = parseAbi([
  `function token() view returns (address)`,
  `function tokenReserve() view returns (uint256)`,
  `function ethReserve() view returns (uint256)`,
  `function virtualTokenReserve() view returns (uint256)`,
  `function virtualEthReserve() view returns (uint256)`,
  `function graduationTargetEth() view returns (uint256)`,
  `function curveSupply() view returns (uint256)`,
  `function tradeFeeBps() view returns (uint16)`,
  `function graduated() view returns (bool)`,
  `function priceWeiPerToken() view returns (uint256)`,
  `function quoteBuy(uint256 ethIn) view returns (uint256 tokensOut, uint256 fee)`,
  `function quoteSell(uint256 tokensIn) view returns (uint256 ethOut, uint256 fee)`,
  `function buy(uint256 minTokensOut) payable returns (uint256 tokensOut)`,
  `function sell(uint256 tokensIn, uint256 minEthOut) returns (uint256 ethOut)`,
  `event Trade(address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 ethReserve, uint256 tokenReserve, uint256 timestamp)`,
  `event Graduated(uint256 ethReserve, uint256 tokenReserve, uint256 timestamp)`,
] as const);

export const curveFactoryAbi = parseAbi([
  `function curveFor(address token) view returns (address)`,
  `function predictCurveAddress(address token) view returns (address)`,
  `function defaultCurveSupply() view returns (uint256)`,
  `function defaultGraduationTargetEth() view returns (uint256)`,
] as const);

/// Same shape as `erc20FactoryAbi.predictAddress` — used for both ERC-721A + ERC-1155 factories.
export const nftFactoryAbi = parseAbi([
  `function implFor(bytes32 configHash) view returns (address)`,
  `function predictAddress(address launcher, string name, string ticker, bytes32 configHash) view returns (address)`,
] as const);

export const royaltyRouterFactoryAbi = parseAbi([
  `function IMPLEMENTATION() view returns (address)`,
  `function PLATFORM_BPS() view returns (uint16)`,
  `function platformSink() view returns (address)`,
  `function predictFor(address collection) view returns (address)`,
  `function deployFor(address collection, address launcherPayout) returns (address clone)`,
  `event RoyaltyRouterDeployed(address indexed collection, address indexed clone, address indexed launcherPayout, uint16 launcherBps, uint16 platformBps)`,
] as const);

export const royaltyRouterAbi = parseAbi([
  `function launcherPayout() view returns (address)`,
  `function platformSink() view returns (address)`,
  `function launcherBps() view returns (uint16)`,
  `function platformBps() view returns (uint16)`,
  `function setLauncherPayout(address newPayout)`,
  `function distributeStuck()`,
] as const);
