/// Prints Universal Router calldata for SELL 1,000,000 REH404 -> URU on
/// Robinhood (4663), amountOutMinimum 0, so it can be replayed on an anvil
/// fork. Prints only; sends nothing.
///
/// Run:
///   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/ur-erc20-swap-check.mjs
///
/// Replay on a fork (the seller needs REH404 plus both approvals first):
///   anvil --fork-url $ROBINHOOD_RPC_URL --auto-impersonate
///   cast send <REH404> 'approve(address,uint256)' <PERMIT2> <max> --from <seller> --unlocked
///   cast send <PERMIT2> 'approve(address,address,uint160,uint48)' <REH404> <UR> <max160> <expiry> --from <seller> --unlocked
///   cast send <to> <data> --from <seller> --unlocked

import { encodeFunctionData } from 'viem';
import { buildErc20PoolKey, encodeV4ExactInSingle, poolIdOf } from '../src/lib/v4Erc20Swap.ts';
import { universalRouterAbi } from '../src/lib/abis.ts';

const REH404 = '0x46377623F4Dd0470f5eA6F6120146F0801a26514';
const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24';
const DN404_HOST = '0x6d8701058E4eecA3bF80D14bD6C13A89575460C4';
const UNIVERSAL_ROUTER = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const key = buildErc20PoolKey(REH404, URU, DN404_HOST);
const tokenIsCurrency0 = key.currency0.toLowerCase() === REH404.toLowerCase();
const amountIn = 1_000_000n * 10n ** 18n;
const { commands, inputs } = encodeV4ExactInSingle({
  chainId: 4663,
  key,
  zeroForOne: tokenIsCurrency0, // selling the token
  amountIn,
  amountOutMinimum: 0n,
});
// Far-future deadline so the printed calldata stays replayable.
const deadline = 2n ** 48n - 1n;
const data = encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [commands, inputs, deadline] });

console.log(JSON.stringify({
  chainId: 4663,
  poolId: poolIdOf(key),
  poolKey: key,
  zeroForOne: tokenIsCurrency0,
  amountIn: amountIn.toString(),
  permit2: PERMIT2,
  to: UNIVERSAL_ROUTER,
  data,
}, null, 2));
