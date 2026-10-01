import { keccak256, encodeAbiParameters, decodeAbiParameters } from 'viem';

/// v4 PoolId for an ERC-20/ERC-20 graduation (DN404 pair-currency curves).
/// Unlike the ETH lane's computeV4PoolId (ETH is always currency0), token and
/// pair are sorted numerically, exactly as Dn404Graduator builds the PoolKey.
/// Fee / tickSpacing are the launchpad's fixed graduation shape (3000 / 60).
/// Kept outside src/ so tests can import it without Ponder's virtual modules.
export function computePairPoolId(
  tokenAddress: `0x${string}`,
  pairCurrency: `0x${string}`,
  hookAddress: `0x${string}`,
): `0x${string}` {
  const [c0, c1] = BigInt(tokenAddress) < BigInt(pairCurrency)
    ? [tokenAddress, pairCurrency]
    : [pairCurrency, tokenAddress];
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [c0, c1, 3000, 60, hookAddress],
    ),
  );
}

/// Block interval of the PairPoolSwaps job (~60s on Robinhood, ~0.1s blocks).
/// Must stay <= 5000: the RPC caps unbounded-response eth_getLogs at 5000 blocks.
export const PAIR_POOL_SWAPS_INTERVAL = 600;

/// keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
export const V4_SWAP_TOPIC0 =
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as const;

export interface RawLog {
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}

export interface DecodedPairSwap {
  poolId: `0x${string}`;
  sender: `0x${string}`;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
  isBuy: boolean;
  pairAmount: bigint;
  tokenAmount: bigint;
  pricePairPerToken: bigint;
}

/// Decode a PoolManager Swap log for a token/pair pool. v4 emits amounts from
/// the SWAPPER side (negative = swapper paid that currency in), so a buy is the
/// swapper receiving the launch token. Price is the post-swap spot in pair per
/// whole token, 1e18-scaled, for either currency ordering.
export function decodePairSwap(log: RawLog, tokenAddress: `0x${string}`, pairCurrency: `0x${string}`): DecodedPairSwap {
  const [amount0, amount1, sqrtPriceX96, liquidity, tick, fee] = decodeAbiParameters(
    [
      { type: 'int128' }, { type: 'int128' }, { type: 'uint160' },
      { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' },
    ],
    log.data,
  );
  const tokenIsC0 = BigInt(tokenAddress) < BigInt(pairCurrency);
  const tokenDelta = tokenIsC0 ? amount0 : amount1;
  const pairDelta = tokenIsC0 ? amount1 : amount0;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const sq = sqrtPriceX96 * sqrtPriceX96;
  // sqrtPriceX96^2 / 2^192 = currency1 per currency0.
  const pricePairPerToken = sq === 0n
    ? 0n
    : tokenIsC0
      ? (sq * 10n ** 18n) >> 192n
      : ((10n ** 18n) << 192n) / sq;
  return {
    poolId: log.topics[1] as `0x${string}`,
    sender: `0x${(log.topics[2] ?? '0x').slice(26)}` as `0x${string}`,
    amount0,
    amount1,
    sqrtPriceX96,
    liquidity,
    tick: Number(tick),
    fee: Number(fee),
    isBuy: tokenDelta > 0n,
    pairAmount: abs(pairDelta),
    tokenAmount: abs(tokenDelta),
    pricePairPerToken,
  };
}
