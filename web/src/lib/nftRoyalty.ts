import { encodeAbiParameters, keccak256, toBytes, type Address, type PublicClient } from 'viem';
import { nftFactoryAbi, royaltyRouterFactoryAbi } from './abis';

/**
 * NFT-launch royalty helper — predicted-address flow.
 *
 * When NFT launches turn on and a launcher wants their ERC-2981 royalty stream to auto-split
 * between themselves (95%) and the platform flywheel (5%), the ERC-2981 module needs to be
 * initialized with the royalty router clone's address as the receiver. But the clone doesn't
 * exist yet — it gets materialized post-launch via `royaltyFactory.deployFor(collection, ...)`.
 *
 * The trick: the clone address is CREATE2-deterministic in `collection`, and the collection
 * address is CREATE2-deterministic in `(launcher, name, ticker, configHash)`. So we can
 * predict both BEFORE launch and bake the predicted clone address into the 2981 init.
 *
 * Marketplaces sending ETH to a not-yet-materialized clone address is fine — ETH lands at
 * the deterministic address, and once anyone (launcher, keeper, bot) triggers `deployFor`,
 * the clone materializes and `distributeStuck()` can flush the accumulated balance.
 */

export interface PredictedRoyaltyRouting {
  /** The collection address after `Router.launch` succeeds. */
  collection: Address;
  /** The royalty router clone address that will materialize post-launch. */
  royaltyClone: Address;
  /** Encoded (receiver, feeBps) — pass this as the ERC2981Royalty module's `moduleData` slice. */
  royaltyInitData: `0x${string}`;
}

/** Read the ERC-2981 royalty bps a launcher wants (marketplace-visible percent × 100). */
export interface RoyaltyConfig {
  /** Total royalty bps marketplaces pay on secondary sales, e.g. 500 for 5%. */
  totalRoyaltyBps: number;
}

/**
 * Compute the deterministic addresses and encoded 2981 init data for a not-yet-launched NFT
 * collection. Call BEFORE `Router.launch` so the 2981 module can be seeded with the correct
 * royalty receiver address.
 */
export async function predictRoyaltyRouting(
  client: PublicClient,
  args: {
    factory: Address;
    royaltyFactory: Address;
    launcher: Address;
    name: string;
    ticker: string;
    configHash: `0x${string}`;
    royalty: RoyaltyConfig;
  }
): Promise<PredictedRoyaltyRouting> {
  const collection = (await client.readContract({
    address: args.factory,
    abi: nftFactoryAbi,
    functionName: 'predictAddress',
    args: [args.launcher, args.name, args.ticker, args.configHash],
  })) as Address;

  const royaltyClone = (await client.readContract({
    address: args.royaltyFactory,
    abi: royaltyRouterFactoryAbi,
    functionName: 'predictFor',
    args: [collection],
  })) as Address;

  // ERC2981Royalty.frag.sol init signature: abi.decode(moduleData, (address, uint96))
  const royaltyInitData = encodeAbiParameters(
    [
      { name: 'receiver', type: 'address' },
      { name: 'feeBps', type: 'uint96' },
    ],
    [royaltyClone, BigInt(args.royalty.totalRoyaltyBps)]
  );

  return { collection, royaltyClone, royaltyInitData };
}

/**
 * Post-launch: materialize the royalty router clone. Idempotent — any wallet can trigger, but
 * the deploy address is fixed per collection. Returns the clone address.
 *
 * This is a plain wagmi/viem write call; wrapped here so callers don't have to remember the
 * ABI + function signature. Use with `useWriteContract` or `walletClient.writeContract`.
 */
export const materializeRoyaltyClone = {
  address: (routerFactory: Address) => routerFactory,
  abi: royaltyRouterFactoryAbi,
  functionName: 'deployFor' as const,
  build(routerFactory: Address, collection: Address, launcherPayout: Address) {
    return {
      address: routerFactory,
      abi: royaltyRouterFactoryAbi,
      functionName: 'deployFor' as const,
      args: [collection, launcherPayout] as const,
    };
  },
};

/**
 * Compute the ERC-2981 config-hash slice matching the on-chain `PhaseX_CONFIG` derivation.
 * Kept in sync with `DeployPhase1.s.sol`: `keccak256(abi.encode(baseName, sortedModuleList))`.
 * Not currently used inside this file — exported as a convenience for the caller building
 * `LaunchParams` for a 721A/1155 launch that includes `ERC2981Royalty` in its module set.
 */
export function configHashOf(baseName: 'ERC20' | 'ERC721A' | 'ERC1155', sortedModuleIds: string[]): `0x${string}` {
  const encoded = encodeAbiParameters(
    [
      { name: 'base', type: 'string' },
      { name: 'modules', type: 'string' },
    ],
    [baseName, sortedModuleIds.join(',')]
  );
  return keccak256(toBytes(encoded));
}
