import { keccak256, encodeAbiParameters } from 'viem';

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
