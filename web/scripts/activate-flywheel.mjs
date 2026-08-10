#!/usr/bin/env node
// -----------------------------------------------------------------------------
// activate-flywheel.mjs
//
// Idempotent Wednesday-launch activation of the 6 flywheel admin changes that
// were proposed on 2026-08-10. Reads current on-chain state, checks each
// timelock is elapsed, calls the matching setter, verifies it took effect.
//
// Safe to re-run: any activation that already fired is skipped cleanly; any
// activation still in its timelock window prints a wait message.
//
// Prerequisites in .env at repo root:
//   ROBINHOOD_RPC_URL       — the Robinhood mainnet RPC (Alchemy or public)
//   DEV_PRIVATE_KEY         — vault owner + intended keeper wallet
//
// Run from repo root:
//   pnpm --filter web exec node scripts/activate-flywheel.mjs
// or from web/:
//   pnpm exec node scripts/activate-flywheel.mjs
//
// Companion cast/curl-free workflow: everything happens through viem so gas +
// nonce management match production behavior exactly.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseAbi,
  defineChain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------- config

// Script lives at web/scripts/*.mjs; repo root is two levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load .env quickly without pulling in a dep — the repo doesn't use dotenv here.
const envFile = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
const env = Object.fromEntries(
  envFile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const eq = line.indexOf('=');
      return [line.slice(0, eq), line.slice(eq + 1)];
    }),
);

const RPC_URL =
  env.ROBINHOOD_RPC_URL ??
  env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ??
  'https://rpc.mainnet.chain.robinhood.com';
const PRIVATE_KEY = env.DEV_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('missing DEV_PRIVATE_KEY in .env');
  process.exit(1);
}

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const account = privateKeyToAccount(
  PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`,
);
const publicClient = createPublicClient({ chain: robinhood, transport: http(RPC_URL) });
const walletClient = createWalletClient({ chain: robinhood, account, transport: http(RPC_URL) });

// ---------------------------------------------------------------- addresses + values
// These are the exact values proposed on 2026-08-10 via `proposeAdminChange`.
// The changeIds on chain were computed from these, so activation only works
// when the setter is called with these SAME values. Editing any of them here
// means the setter call reverts with AdminChangeNotProposed.

const DEPLOYER = '0x6d606cc634F20f5534fba072757F2c2C7B835Bb9';
const UNIVERSAL_ROUTER = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const URU_BUYBACK_VAULT = '0x78E388F9B1bABAa61BB17Bbd41A2B499CfE503a1';
const URU_DEPOSIT_SINK = '0xeCD30ea7d0945A99b2032af4A6ad9d5bF345B8C8';

// 80% of spot URU/WETH price computed from pool sqrtPriceX96 on 2026-08-10.
// These are the exact numbers passed to rateChangeId in the propose txs.
const MIN_URU_PER_ETH = 2058408689714102135685120n; // ~2.06e24 URU wei per 1e18 ETH wei
const MIN_ETH_PER_URU = 310919791195n; // ~3.11e11 ETH wei per 1e18 URU wei

// Solady Ownable + timelocked-admin surface shared by both vault contracts.
const VAULT_ABI = parseAbi([
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
  'function setKeeper(address keeper, bool allowed)',
  'function setSwapTarget(address target, bool allowed)',
  'function setMinUruPerEth(uint256 rate)',
  'function setMinEthPerUru(uint256 rate)',
]);

// ---------------------------------------------------------------- helpers

const ts = () => new Date().toISOString();
const say = (msg) => console.log(`[${ts()}] ${msg}`);

async function nowSec() {
  const block = await publicClient.getBlock();
  return Number(block.timestamp);
}

// Read the changeId + its readyAt + return one of:
//   'not-proposed'  → nothing to activate (either never proposed, or already
//                     consumed — check the actual state via getCurrent below)
//   'waiting'       → proposed but timelock not elapsed
//   'ready'         → OK to call the setter
async function checkChange(vaultAddr, changeId, now) {
  const readyAt = await publicClient.readContract({
    address: vaultAddr,
    abi: VAULT_ABI,
    functionName: 'adminChangeReadyAt',
    args: [changeId],
  });
  const readyAtNum = Number(readyAt);
  if (readyAtNum === 0) return { state: 'not-proposed', readyAt: 0 };
  if (readyAtNum > now) return { state: 'waiting', readyAt: readyAtNum };
  return { state: 'ready', readyAt: readyAtNum };
}

// Executes an activation step. Idempotent: if `getCurrent` already matches the
// target value, we skip the tx. If the propose is still in timelock we log and
// skip. Otherwise we send the setter tx and verify.
async function activateStep({
  label,
  vaultAddr,
  changeId,
  setterFn,
  setterArgs,
  getCurrent,
  targetValue,
  now,
}) {
  const current = await getCurrent();
  if (current === targetValue) {
    say(`  ✓ ${label} — already at target (${current}), skipping`);
    return { done: true, skipped: true };
  }
  const change = await checkChange(vaultAddr, changeId, now);
  if (change.state === 'not-proposed') {
    say(`  ⚠ ${label} — NOT PROPOSED (readyAt=0). Either never proposed or already consumed but state disagrees. bail.`);
    return { done: false, error: 'not-proposed' };
  }
  if (change.state === 'waiting') {
    const remainSec = change.readyAt - now;
    const remainMin = Math.ceil(remainSec / 60);
    say(`  ⏳ ${label} — timelock still ticking, ${remainMin} min until ready (readyAt=${new Date(change.readyAt * 1000).toISOString()})`);
    return { done: false, error: 'waiting' };
  }
  say(`  → ${label} — calling ${setterFn}(${setterArgs.map(String).join(', ')})`);
  const txHash = await walletClient.writeContract({
    address: vaultAddr,
    abi: VAULT_ABI,
    functionName: setterFn,
    args: setterArgs,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    say(`  ✗ ${label} — tx reverted, hash ${txHash}`);
    return { done: false, error: 'reverted', txHash };
  }
  const post = await getCurrent();
  if (post !== targetValue) {
    say(`  ✗ ${label} — tx landed but post-state (${post}) still != target (${targetValue}). manual investigation needed. tx ${txHash}`);
    return { done: false, error: 'state-mismatch', txHash };
  }
  say(`  ✓ ${label} — activated, tx ${txHash}, block ${receipt.blockNumber}`);
  return { done: true, txHash };
}

// ---------------------------------------------------------------- run

async function main() {
  say(`connected as ${account.address}`);
  say(`  balance: ${formatEther(await publicClient.getBalance({ address: account.address }))} ETH`);

  const now = await nowSec();
  say(`chain time: ${new Date(now * 1000).toISOString()} (${now})`);

  // Precompute all 6 changeIds via the vault contracts themselves so we can't
  // drift from the on-chain encoding.
  const [
    ubKeeperId,
    ubSwapId,
    ubRateId,
    udKeeperId,
    udSwapId,
    udRateId,
  ] = await Promise.all([
    publicClient.readContract({ address: URU_BUYBACK_VAULT, abi: VAULT_ABI, functionName: 'keeperChangeId', args: [DEPLOYER, true] }),
    publicClient.readContract({ address: URU_BUYBACK_VAULT, abi: VAULT_ABI, functionName: 'swapTargetChangeId', args: [UNIVERSAL_ROUTER, true] }),
    publicClient.readContract({ address: URU_BUYBACK_VAULT, abi: VAULT_ABI, functionName: 'rateChangeId', args: [MIN_URU_PER_ETH] }),
    publicClient.readContract({ address: URU_DEPOSIT_SINK, abi: VAULT_ABI, functionName: 'keeperChangeId', args: [DEPLOYER, true] }),
    publicClient.readContract({ address: URU_DEPOSIT_SINK, abi: VAULT_ABI, functionName: 'swapTargetChangeId', args: [UNIVERSAL_ROUTER, true] }),
    publicClient.readContract({ address: URU_DEPOSIT_SINK, abi: VAULT_ABI, functionName: 'rateChangeId', args: [MIN_ETH_PER_URU] }),
  ]);

  say('');
  say('=== UruBuybackVault (0x78E388...) — ETH → URU direction ===');
  const ubResults = await Promise.all([
    activateStep({
      label: 'set keeper = deployer',
      vaultAddr: URU_BUYBACK_VAULT,
      changeId: ubKeeperId,
      setterFn: 'setKeeper',
      setterArgs: [DEPLOYER, true],
      getCurrent: async () => publicClient.readContract({
        address: URU_BUYBACK_VAULT, abi: VAULT_ABI, functionName: 'isKeeper', args: [DEPLOYER],
      }),
      targetValue: true,
      now,
    }),
  ]);
  const ubResults2 = await activateStep({
    label: 'set swapTarget = UniversalRouter',
    vaultAddr: URU_BUYBACK_VAULT,
    changeId: ubSwapId,
    setterFn: 'setSwapTarget',
    setterArgs: [UNIVERSAL_ROUTER, true],
    getCurrent: async () => publicClient.readContract({
      address: URU_BUYBACK_VAULT, abi: VAULT_ABI, functionName: 'isSwapTarget', args: [UNIVERSAL_ROUTER],
    }),
    targetValue: true,
    now,
  });
  const ubResults3 = await activateStep({
    label: `set minUruPerEth = ${MIN_URU_PER_ETH}`,
    vaultAddr: URU_BUYBACK_VAULT,
    changeId: ubRateId,
    setterFn: 'setMinUruPerEth',
    setterArgs: [MIN_URU_PER_ETH],
    getCurrent: async () => publicClient.readContract({
      address: URU_BUYBACK_VAULT, abi: VAULT_ABI, functionName: 'minUruPerEth',
    }),
    targetValue: MIN_URU_PER_ETH,
    now,
  });

  say('');
  say('=== UruDepositSink (0xeCD30e...) — URU → ETH direction ===');
  const udResults1 = await activateStep({
    label: 'set keeper = deployer',
    vaultAddr: URU_DEPOSIT_SINK,
    changeId: udKeeperId,
    setterFn: 'setKeeper',
    setterArgs: [DEPLOYER, true],
    getCurrent: async () => publicClient.readContract({
      address: URU_DEPOSIT_SINK, abi: VAULT_ABI, functionName: 'isKeeper', args: [DEPLOYER],
    }),
    targetValue: true,
    now,
  });
  const udResults2 = await activateStep({
    label: 'set swapTarget = UniversalRouter',
    vaultAddr: URU_DEPOSIT_SINK,
    changeId: udSwapId,
    setterFn: 'setSwapTarget',
    setterArgs: [UNIVERSAL_ROUTER, true],
    getCurrent: async () => publicClient.readContract({
      address: URU_DEPOSIT_SINK, abi: VAULT_ABI, functionName: 'isSwapTarget', args: [UNIVERSAL_ROUTER],
    }),
    targetValue: true,
    now,
  });
  const udResults3 = await activateStep({
    label: `set minEthPerUru = ${MIN_ETH_PER_URU}`,
    vaultAddr: URU_DEPOSIT_SINK,
    changeId: udRateId,
    setterFn: 'setMinEthPerUru',
    setterArgs: [MIN_ETH_PER_URU],
    getCurrent: async () => publicClient.readContract({
      address: URU_DEPOSIT_SINK, abi: VAULT_ABI, functionName: 'minEthPerUru',
    }),
    targetValue: MIN_ETH_PER_URU,
    now,
  });

  // ---------------------------------------------------------- final state

  say('');
  say('=== final vault state ===');
  const [ubIsKeep, ubIsTarg, ubMin, udIsKeep, udIsTarg, udMin] = await Promise.all([
    publicClient.readContract({ address: URU_BUYBACK_VAULT, abi: VAULT_ABI, functionName: 'isKeeper', args: [DEPLOYER] }),
    publicClient.readContract({ address: URU_BUYBACK_VAULT, abi: VAULT_ABI, functionName: 'isSwapTarget', args: [UNIVERSAL_ROUTER] }),
    publicClient.readContract({ address: URU_BUYBACK_VAULT, abi: VAULT_ABI, functionName: 'minUruPerEth' }),
    publicClient.readContract({ address: URU_DEPOSIT_SINK, abi: VAULT_ABI, functionName: 'isKeeper', args: [DEPLOYER] }),
    publicClient.readContract({ address: URU_DEPOSIT_SINK, abi: VAULT_ABI, functionName: 'isSwapTarget', args: [UNIVERSAL_ROUTER] }),
    publicClient.readContract({ address: URU_DEPOSIT_SINK, abi: VAULT_ABI, functionName: 'minEthPerUru' }),
  ]);
  say(`  UruBuybackVault.isKeeper(deployer):         ${ubIsKeep}`);
  say(`  UruBuybackVault.isSwapTarget(UR):           ${ubIsTarg}`);
  say(`  UruBuybackVault.minUruPerEth:               ${ubMin}`);
  say(`  UruDepositSink.isKeeper(deployer):          ${udIsKeep}`);
  say(`  UruDepositSink.isSwapTarget(UR):            ${udIsTarg}`);
  say(`  UruDepositSink.minEthPerUru:                ${udMin}`);

  const allGood =
    ubIsKeep && ubIsTarg && ubMin === MIN_URU_PER_ETH &&
    udIsKeep && udIsTarg && udMin === MIN_ETH_PER_URU;

  say('');
  if (allGood) {
    say('✿ all 6 admin changes activated. flywheel is wired for launch.');
    say('  next: test executeBuyback with a small ETH transfer to UruBuybackVault.');
  } else {
    say('~ some steps still pending. re-run when timelocks elapse.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('activation failed:', err);
  process.exit(1);
});
