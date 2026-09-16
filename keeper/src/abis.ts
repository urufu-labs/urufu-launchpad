/**
 * Minimal ABIs the keeper reads/writes. Kept narrow on purpose — full
 * ABIs live under contracts/out; we only import what the keeper actually
 * touches so type errors are loud when the on-chain surface drifts.
 */

/// Dn404TaxTemplate — the tax-hook contract that lives on every
/// tax-enabled DN404 base clone. Keeper reads `accumulatedTax`, `taxMode`,
/// `taxTarget`, `uruToken`, `keeper` (auth check) and calls
/// `sweepAccumulated` when a launch's accumulator crosses threshold.
export const dn404TaxTemplateAbi = [
  {
    type: 'function',
    name: 'accumulatedTax',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'taxMode',
    inputs: [],
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'taxTarget',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'uruToken',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'keeper',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'sweepAccumulated',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [
      { name: 'net', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'TaxAccumulated',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'gross', type: 'uint256', indexed: false },
      { name: 'tax', type: 'uint256', indexed: false },
      { name: 'mode', type: 'uint8', indexed: true },
      { name: 'target', type: 'address', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'KeeperSwept',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'net', type: 'uint256', indexed: false },
      { name: 'keeperFee', type: 'uint256', indexed: false },
      { name: 'mode', type: 'uint8', indexed: false },
    ],
    anonymous: false,
  },
] as const;

/// Standard ERC-20 surface used for post-sweep swaps + transfers.
export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { type: 'address' },
      { type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { type: 'address' },
      { type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

/// V4SwapRouter — the launchpad's periphery contract that wraps
/// PoolManager.swap for simple exact-input token→token swaps. Used by
/// BuybackURU + BuyAllowedToken handlers to convert the swept launch
/// token into the destination asset.
export const v4SwapRouterAbi = [
  {
    type: 'function',
    name: 'swapExactTokenForToken',
    inputs: [
      {
        name: 'key',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;
