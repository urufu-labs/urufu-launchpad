#!/usr/bin/env node
// -----------------------------------------------------------------------------
// check-flywheel-state.mjs
//
// READ-ONLY status probe for the 6 flywheel proposals. Prints each change's
// on-chain readiness (already-active / ready-to-activate / waiting-on-timelock)
// and each vault's ETH + URU balances so you can see what a triggered buyback
// would actually move.
//
// No transactions. Safe to run any time.
//
//   pnpm --filter web exec node scripts/check-flywheel-state.mjs
// or from web/:
//   pnpm exec node scripts/check-flywheel-state.mjs
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPublicClient, http, formatEther, parseAbi, defineChain } from 'viem';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
const env = Object.fromEntries(
  envFile
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const eq = l.indexOf('=');
      return [l.slice(0, eq), l.slice(eq + 1)];
    }),
);

const RPC_URL =
  env.ROBINHOOD_RPC_URL ??
  env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ??
  'https://rpc.mainnet.chain.robinhood.com';

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const client = createPublicClient({ chain: robinhood, transport: http(RPC_URL) });

const DEPLOYER = '0x6d606cc634F20f5534fba072757F2c2C7B835Bb9';
const UNIVERSAL_ROUTER = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const URU_BUYBACK_VAULT = '0x78E388F9B1bABAa61BB17Bbd41A2B499CfE503a1';
const URU_DEPOSIT_SINK = '0xeCD30ea7d0945A99b2032af4A6ad9d5bF345B8C8';
const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24';

const MIN_URU_PER_ETH = 2058408689714102135685120n;
const MIN_ETH_PER_URU = 310919791195n;

const ABI = parseAbi([
  'function owner() view returns (address)',
  'function isKeeper(address) view returns (bool)',
  'function isSwapTarget(address) view returns (bool)',
  'function minUruPerEth() view returns (uint256)',
  'function minEthPerUru() view returns (uint256)',
  'function minConfigDelay() view returns (uint256)',
  'function adminChangeReadyAt(bytes32) view returns (uint256)',
  'function keeperChangeId(address keeper, bool allowed) pure returns (bytes32)',
  'function swapTargetChangeId(address target, bool allowed) pure returns (bytes32)',
  'function rateChangeId(uint256 rate) pure returns (bytes32)',
]);

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
]);

async function main() {
  const now = Number((await client.getBlock()).timestamp);
  console.log(`chain time: ${new Date(now * 1000).toISOString()} (${now})`);
  console.log('');

  for (const [label, vaultAddr, isUp] of [
    ['UruBuybackVault (ETH → URU)', URU_BUYBACK_VAULT, true],
    ['UruDepositSink (URU → ETH)', URU_DEPOSIT_SINK, false],
  ]) {
    console.log(`=== ${label} @ ${vaultAddr} ===`);

    const [ethBal, uruBal, owner, delay, isKeep, isTgt, curRate] = await Promise.all([
      client.getBalance({ address: vaultAddr }),
      client.readContract({ address: URU, abi: ERC20, functionName: 'balanceOf', args: [vaultAddr] }),
      client.readContract({ address: vaultAddr, abi: ABI, functionName: 'owner' }),
      client.readContract({ address: vaultAddr, abi: ABI, functionName: 'minConfigDelay' }),
      client.readContract({ address: vaultAddr, abi: ABI, functionName: 'isKeeper', args: [DEPLOYER] }),
      client.readContract({ address: vaultAddr, abi: ABI, functionName: 'isSwapTarget', args: [UNIVERSAL_ROUTER] }),
      client.readContract({
        address: vaultAddr, abi: ABI,
        functionName: isUp ? 'minUruPerEth' : 'minEthPerUru',
      }),
    ]);
    console.log(`  balances: ${formatEther(ethBal)} ETH  |  ${formatEther(uruBal)} URU`);
    console.log(`  owner: ${owner}`);
    console.log(`  minConfigDelay: ${delay}s`);
    console.log(`  isKeeper(deployer): ${isKeep ? 'YES ✓' : 'NO — needs activation'}`);
    console.log(`  isSwapTarget(UR):   ${isTgt ? 'YES ✓' : 'NO — needs activation'}`);
    const targetRate = isUp ? MIN_URU_PER_ETH : MIN_ETH_PER_URU;
    console.log(
      `  rate: ${curRate} ${curRate === targetRate ? '(matches target ✓)' : '(needs activation → ' + targetRate + ')'}`,
    );

    for (const [step, changeIdFn, args, current, target] of [
      ['setKeeper', 'keeperChangeId', [DEPLOYER, true], isKeep, true],
      ['setSwapTarget', 'swapTargetChangeId', [UNIVERSAL_ROUTER, true], isTgt, true],
      [isUp ? 'setMinUruPerEth' : 'setMinEthPerUru', 'rateChangeId', [targetRate], curRate, targetRate],
    ]) {
      if (current === target) {
        console.log(`    ✓ ${step} — already active`);
        continue;
      }
      const cid = await client.readContract({
        address: vaultAddr, abi: ABI, functionName: changeIdFn, args,
      });
      const readyAt = Number(
        await client.readContract({
          address: vaultAddr, abi: ABI, functionName: 'adminChangeReadyAt', args: [cid],
        }),
      );
      if (readyAt === 0) {
        console.log(`    ⚠ ${step} — NOT PROPOSED (readyAt=0)`);
      } else if (readyAt > now) {
        const wait = Math.ceil((readyAt - now) / 60);
        console.log(`    ⏳ ${step} — waiting ${wait} min (ready ${new Date(readyAt * 1000).toISOString()})`);
      } else {
        console.log(`    ✅ ${step} — READY TO ACTIVATE (readyAt ${new Date(readyAt * 1000).toISOString()})`);
      }
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
