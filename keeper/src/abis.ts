/**
 * Minimal ABIs the keeper touches, human-readable via viem parseAbi so a
 * drifted on-chain surface fails loudly at encode time.
 */
import { parseAbi } from 'viem';

/// Dn404LaunchFactory.Dn404Launched — MUST match the contract field-for-field
/// (same 14-field string as indexer/ponder.config.ts; topic0
/// 0x68365ce95c6edf66a41eb43906537daf339f288d09b8f33eecfa542d4b240439).
export const dn404LaunchFactoryAbi = parseAbi([
  'event Dn404Launched(address indexed base, address indexed mirror, address indexed curve, address launcher, address pairCurrency, uint8 taxMode, uint16 taxBps, bytes32 configHash, uint256 uruPaid, uint256 totalSupply, uint256 unit, uint256 founderPremint, string name, string ticker)',
  'function setTaxWiring(address taxKeeper_, address taxKeeperTreasury_, address taxAllowlist_)',
  'function taxKeeper() view returns (address)',
  'function taxAllowlist() view returns (address)',
]);

/// Dn404TaxTemplate (V1/V2 share this surface) + DN404 base views.
export const dn404TaxTemplateAbi = parseAbi([
  'function accumulatedTax() view returns (uint256)',
  'function taxMode() view returns (uint8)',
  'function taxBps() view returns (uint16)',
  'function taxTarget() view returns (address)',
  'function uruToken() view returns (address)',
  'function keeper() view returns (address)',
  'function keeperTreasury() view returns (address)',
  'function owner() view returns (address)',
  'function unit() view returns (uint256)',
  'function mirrorERC721() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function getSkipNFT(address) view returns (bool)',
  'function setSkipNFT(bool skipNFT) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function sweepAccumulated(address recipient, uint256 amount) returns (uint256 net, uint256 fee)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event KeeperSwept(address indexed recipient, uint256 net, uint256 keeperFee, uint8 mode)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
]);

export const wethAbi = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function balanceOf(address) view returns (uint256)',
]);

export const curveAbi = parseAbi([
  'function graduated() view returns (bool)',
]);

export const mirrorAbi = parseAbi([
  'function ownerOf(uint256 id) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);

export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

export const positionManagerAbi = parseAbi([
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function nextTokenId() view returns (uint256)',
  'function ownerOf(uint256 id) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
]);
