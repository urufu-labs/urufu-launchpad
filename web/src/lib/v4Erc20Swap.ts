/// Uniswap v4 swap calldata for ERC-20 / ERC-20 pools, via the Universal Router.
///
/// Why this exists: our own `V4SwapRouter` only knows native-ETH pools
/// (`currency0 == address(0)`). DN404 launches that pick an ERC-20 pair
/// currency (URU today) graduate into a token/URU pool, so the post-graduation
/// widget for those tokens goes through Uniswap's Universal Router instead:
///
///   UR.execute(commands = [V4_SWAP], inputs = [abi.encode(actions, params)])
///     actions = SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
///
/// The router pulls the input token through Permit2, so the caller needs
/// `token.approve(PERMIT2)` and `permit2.approve(token, router, ...)` first.
///
/// Struct gotcha (see reference_v4_ur_struct_divergence memory): Robinhood's
/// router is built on a newer v4-periphery where `ExactInputSingleParams`
/// carries `uint256 minHopPriceX36` between `amountOutMinimum` and `hookData`.
/// Encoding the legacy layout against it misaligns calldata and the router
/// reverts with empty data. `encodeV4ExactInSingle` picks the layout by chain.
///
/// Nothing here touches the ETH path or the bonding-curve path.

import { concatHex, encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

export const UR_COMMAND_V4_SWAP = 0x10;
export const V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
export const V4_ACTION_SETTLE_ALL = 0x0c;
export const V4_ACTION_TAKE_ALL = 0x0f;

/// Chains whose Universal Router decodes the newer struct with `minHopPriceX36`.
export const CHAINS_WITH_MIN_HOP_PRICE: ReadonlySet<number> = new Set([4663]);

export interface Erc20PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/// v4 requires currency0 < currency1 numerically. Same sort the graduator does.
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/// PoolKey for a graduated DN404 pair-currency pool. Fee + tick spacing are the
/// launchpad's fixed graduation shape (3000 / 60) unless told otherwise.
export function buildErc20PoolKey(
  token: Address,
  pairCurrency: Address,
  hooks: Address,
  fee = 3000,
  tickSpacing = 60,
): Erc20PoolKey {
  const [currency0, currency1] = sortCurrencies(token, pairCurrency);
  return { currency0, currency1, fee, tickSpacing, hooks };
}

/// keccak256(abi.encode(PoolKey)) — identical to PoolIdLibrary.toId.
export function poolIdOf(key: Erc20PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/// Spot price of `token` in pair-token atomic units per WHOLE token (1e18 base
/// units), from a pool's sqrtPriceX96. `tokenIsCurrency0` decides the inversion:
///   sqrtPriceX96 encodes sqrt(currency1 / currency0) * 2^96.
///   token = currency0  → pair-per-token = sq^2 / 2^192
///   token = currency1  → pair-per-token = 2^192 / sq^2
/// Matches the ETH path's `((1e18) << 192) / sq^2` when the pair is currency0.
export function pairPerTokenFromSqrt(sqrtPriceX96: bigint, tokenIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const sqSq = sqrtPriceX96 * sqrtPriceX96;
  if (sqSq === 0n) return 0n;
  return tokenIsCurrency0
    ? (sqSq * 10n ** 18n) >> 192n
    : ((10n ** 18n) << 192n) / sqSq;
}

export interface V4ExactInSingleArgs {
  chainId: number;
  key: Erc20PoolKey;
  /// true = sell currency0 for currency1.
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  hookData?: Hex;
}

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

/// Build `(commands, inputs)` for `UniversalRouter.execute` performing one
/// exact-input single-hop v4 swap with full settle/take of both sides.
export function encodeV4ExactInSingle(args: V4ExactInSingleArgs): { commands: Hex; inputs: Hex[] } {
  const { chainId, key, zeroForOne, amountIn, amountOutMinimum } = args;
  const hookData: Hex = args.hookData ?? '0x';
  if (amountIn <= 0n) throw new Error('amountIn must be > 0');
  if (amountIn >= 2n ** 128n) throw new Error('amountIn exceeds uint128');
  if (amountOutMinimum >= 2n ** 128n) throw new Error('amountOutMinimum exceeds uint128');

  const keyTuple = {
    currency0: key.currency0,
    currency1: key.currency1,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
  };

  // ExactInputSingleParams — struct layout chosen per chain (see header).
  const swapParams: Hex = CHAINS_WITH_MIN_HOP_PRICE.has(chainId)
    ? encodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
              { name: 'zeroForOne', type: 'bool' },
              { name: 'amountIn', type: 'uint128' },
              { name: 'amountOutMinimum', type: 'uint128' },
              { name: 'minHopPriceX36', type: 'uint256' },
              { name: 'hookData', type: 'bytes' },
            ],
          },
        ],
        [{ poolKey: keyTuple, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData }],
      )
    : encodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
              { name: 'zeroForOne', type: 'bool' },
              { name: 'amountIn', type: 'uint128' },
              { name: 'amountOutMinimum', type: 'uint128' },
              { name: 'hookData', type: 'bytes' },
            ],
          },
        ],
        [{ poolKey: keyTuple, zeroForOne, amountIn, amountOutMinimum, hookData }],
      );

  const inputCurrency = zeroForOne ? key.currency0 : key.currency1;
  const outputCurrency = zeroForOne ? key.currency1 : key.currency0;
  // SETTLE_ALL(currency, maxAmount) / TAKE_ALL(currency, minAmount)
  const settleParams = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [inputCurrency, amountIn]);
  const takeParams = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [outputCurrency, amountOutMinimum]);

  const actions: Hex = concatHex([
    toByte(V4_ACTION_SWAP_EXACT_IN_SINGLE),
    toByte(V4_ACTION_SETTLE_ALL),
    toByte(V4_ACTION_TAKE_ALL),
  ]);
  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [swapParams, settleParams, takeParams]],
  );

  return { commands: toByte(UR_COMMAND_V4_SWAP), inputs: [v4Input] };
}

function toByte(n: number): Hex {
  return `0x${n.toString(16).padStart(2, '0')}` as Hex;
}
