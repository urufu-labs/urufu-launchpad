/**
 * Robinhood-chain (4663) defaults. Every value can be overridden by env
 * (see config.ts); these exist so a fresh deploy only needs secrets + RPC.
 *
 * Provenance (all verified on chain 2026-10-01):
 *   - Dn404LaunchFactory / hooks / graduators: contracts/deployment-dn404.4663.json
 *     + contracts/deployment-live-rh.4663.json.
 *   - Universal Router, Permit2, PositionManager, StateView, PoolManager:
 *     project_robinhood_addresses memory (Uniswap v4 RH deployment).
 *   - URU/WETH canonical pool: PoolManager Initialize log for id
 *     0xd307e875…0284 (block 18482468): currency0 = WETH 0x0Bd7…AD73,
 *     currency1 = URU, fee 3000, tickSpacing 60, hook UruLaunchHook 0x8933…8044.
 *     NOTE it is WETH-paired, not native ETH, so ETH-side buybacks wrap first.
 */
import type { Address } from 'viem';

export const ZERO: Address = '0x0000000000000000000000000000000000000000';
export const DEAD: Address = '0x000000000000000000000000000000000000dEaD';

export const RH = {
  chainId: 4663,
  launchFactory: '0x3026C71eB13C599BAd0e7a687689D20F8c37A64B' as Address,
  launchFactoryDeployBlock: 63927928n,
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address,
  stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b' as Address,
  universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904' as Address,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7' as Address,
  seaport: '0x0000000000000068F116a894984e2DB1123eB395' as Address,
  uru: '0x9fbe210007dDd8389f98d0253018e65CC48b9D24' as Address,
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
  /// ERC-20 lane host (ETH-paired graduations, incl. ETH-paired DN404).
  hookEth: '0x83d6fa59BEF503112887b16277CF559fDC93E0C4' as Address,
  /// DN404 lane host (ERC-20-paired graduations, e.g. URU).
  hookPair: '0x6d8701058E4eecA3bF80D14bD6C13A89575460C4' as Address,
  graduatorEth: '0xB5aA5Fb4863Fe11ea7BdD6Deaf44004A09BD0C23' as Address,
  graduatorPair: '0xE23E49EeD1a8BEc5c08E6C94e7808Dc96aa02944' as Address,
  uruWethHook: '0x8933d28E68d02FaA02436aeF42E6ba9674698044' as Address,
  uruWethPoolId: '0xd307e8754c65c451ca726c4549917b3f5765cce16a76f35a6d19aaf7bc230284' as `0x${string}`,
} as const;

/// Launchpad graduation pool shape (both lanes).
export const GRAD_FEE = 3000;
export const GRAD_TICK_SPACING = 60;
