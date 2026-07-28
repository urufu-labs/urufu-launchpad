/// Keeper — periodic background jobs that close the flywheel loop:
///
///  1. **sweepMhhToFeeSplitterLoop** (every 60 min)
///     Calls `MultiHookHost.pushOwed(ETH, FeeSplitter)` if the platform slot
///     has any accrued ETH fees. `pushOwed` is permissionless — anyone can
///     call it, but nothing runs on its own. Without this, post-graduation
///     trade fees sit forever in `MHH.owed[FeeSplitter]` and never make it to
///     the vaults. FeeSplitter's `receive()` auto-splits on inflow, so once
///     ETH lands in the splitter it flows straight into UruBuybackVault +
///     NftRevenueVault + treasury per the 40/35/25 config.
///
///  2. **publishEpochLoop** (every 24 h)
///     Calls the same `publishEpoch` flow the operator would trigger via
///     `POST /rewards/rh/publish` — snapshots NFT holders from the indexer,
///     builds a Merkle tree, posts the root on-chain to `NftRevenueVault`,
///     persists the tree so the claim UI can serve proofs. Skips if the
///     vault balance is under a threshold (avoids wasting gas + creating
///     dust epochs when trading is quiet).
///
/// Both loops are:
///   - Opt-in via `KEEPER_ENABLED=true` — off by default so local dev + PR
///     previews don't accidentally publish epochs against prod state.
///   - Idempotent — safe to run twice in a row. `pushOwed` reverts with
///     `NothingToClaim` if owed==0 (caught + logged); `publishEpoch` is
///     gated by a minimum-balance threshold.
///   - Log-friendly — every action prints a single JSON-shaped line so
///     Railway logs stay grep-able.

import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { publishEpoch, vaultSummary } from './rewards.ts';

/// Contract wiring — MultiHookHost + FeeSplitter for the sweep leg. The
/// publish leg reuses `rewards.ts` which reads its own env.
const MHH_ABI = parseAbi([
  'function owed(address currency, address who) view returns (uint256)',
  'function pushOwed(address currency, address account) external',
]);

interface SweepConfig {
  chainId: number;
  rpcUrl: string;
  multiHookHost: Address;
  feeSplitter: Address;
  keeperKey: Hex;
}

function sweepConfig(): SweepConfig | null {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const multiHookHost = process.env.ROBINHOOD_MULTI_HOOK_HOST_ADDRESS as Address | undefined;
  const feeSplitter = process.env.ROBINHOOD_FEE_SPLITTER_ADDRESS as Address | undefined;
  const rawKey = process.env.KEEPER_PRIVATE_KEY;
  if (!rpcUrl || !multiHookHost || !feeSplitter || !rawKey) return null;
  const keeperKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  return { chainId: 4663, rpcUrl, multiHookHost, feeSplitter, keeperKey };
}

const ETH_CURRENCY: Address = '0x0000000000000000000000000000000000000000';

/// How much accrued ETH is worth sweeping. Sub-dust amounts cost more in gas
/// than the swept value; anything above this threshold justifies the tx.
/// Tune down if trading picks up and you want faster reflection in the vault.
const MHH_SWEEP_THRESHOLD_WEI = 10_000_000_000_000n; // 0.00001 ETH ~= a few cents

async function sweepMhhToFeeSplitterOnce(cfg: SweepConfig): Promise<void> {
  const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
  const owed = (await pub.readContract({
    address: cfg.multiHookHost,
    abi: MHH_ABI,
    functionName: 'owed',
    args: [ETH_CURRENCY, cfg.feeSplitter],
  })) as bigint;

  if (owed < MHH_SWEEP_THRESHOLD_WEI) {
    console.log(JSON.stringify({ keeper: 'sweep-mhh', action: 'skip', owed: owed.toString(), threshold: MHH_SWEEP_THRESHOLD_WEI.toString() }));
    return;
  }

  const account = privateKeyToAccount(cfg.keeperKey);
  const wallet = createWalletClient({
    account,
    transport: http(cfg.rpcUrl),
    chain: {
      id: cfg.chainId,
      name: 'robinhood',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    },
  });

  const hash = await wallet.writeContract({
    address: cfg.multiHookHost,
    abi: MHH_ABI,
    functionName: 'pushOwed',
    args: [ETH_CURRENCY, cfg.feeSplitter],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  console.log(JSON.stringify({ keeper: 'sweep-mhh', action: 'swept', owed: owed.toString(), tx: hash, status: receipt.status }));
}

/// Publish an epoch if the vault has enough balance to be worth distributing.
/// Threshold set high enough that dust epochs (a few cents of vault balance)
/// don't spam-publish; low enough that an active week still gets a weekly
/// epoch.
const VAULT_PUBLISH_THRESHOLD_WEI = 1_000_000_000_000_000n; // 0.001 ETH — bump when v4 volume is real

async function publishEpochOnce(): Promise<void> {
  const summary = await vaultSummary('robinhood').catch(() => null);
  if (!summary) {
    console.log(JSON.stringify({ keeper: 'publish-epoch', action: 'skip-no-summary' }));
    return;
  }
  const vaultBal = BigInt(summary.vaultBalance ?? '0');
  if (vaultBal < VAULT_PUBLISH_THRESHOLD_WEI) {
    console.log(JSON.stringify({ keeper: 'publish-epoch', action: 'skip-low-balance', vaultBalance: vaultBal.toString(), threshold: VAULT_PUBLISH_THRESHOLD_WEI.toString() }));
    return;
  }
  try {
    const result = await publishEpoch({ chainSlug: 'robinhood' });
    console.log(JSON.stringify({ keeper: 'publish-epoch', action: 'published', epochId: result.epochId, totalAmount: result.totalAmount, holderCount: result.holderCount, tx: result.txHash }));
  } catch (err) {
    console.log(JSON.stringify({ keeper: 'publish-epoch', action: 'failed', error: (err as Error).message }));
  }
}

/// Sweep loop — 60 min cadence. First run fires 60s after boot to let the
/// server settle + not fight the migrate() DB writes.
function startSweepLoop(cfg: SweepConfig): void {
  const runSafely = async () => {
    try {
      await sweepMhhToFeeSplitterOnce(cfg);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('NothingToClaim')) {
        // Racy edge-case: owed dropped to 0 between the check and the send.
        // Silent skip — the read gate at the top of `sweepMhhToFeeSplitterOnce`
        // catches the common case; this catches the race.
        return;
      }
      console.log(JSON.stringify({ keeper: 'sweep-mhh', action: 'error', error: msg }));
    }
  };
  setTimeout(runSafely, 60_000);
  setInterval(runSafely, 60 * 60 * 1000);
}

/// Publish loop — 24 h cadence. First run 5 min after boot.
function startPublishLoop(): void {
  const runSafely = async () => {
    try {
      await publishEpochOnce();
    } catch (err) {
      console.log(JSON.stringify({ keeper: 'publish-epoch', action: 'error', error: (err as Error).message }));
    }
  };
  setTimeout(runSafely, 5 * 60 * 1000);
  setInterval(runSafely, 24 * 60 * 60 * 1000);
}

/// Entry point — called once from server.ts on boot. Returns a status message
/// so the server can log why it did or didn't start each loop.
export function startKeeper(): { started: string[]; skipped: string[] } {
  const started: string[] = [];
  const skipped: string[] = [];
  if (process.env.KEEPER_ENABLED !== 'true') {
    skipped.push('all-loops (KEEPER_ENABLED != true)');
    return { started, skipped };
  }
  const sweep = sweepConfig();
  if (sweep) {
    startSweepLoop(sweep);
    started.push('sweep-mhh (60min)');
  } else {
    skipped.push('sweep-mhh (missing env: ROBINHOOD_RPC_URL / _MULTI_HOOK_HOST_ADDRESS / _FEE_SPLITTER_ADDRESS / KEEPER_PRIVATE_KEY)');
  }
  // Publish loop reuses env from rewards.ts (chainConfigFor) and doesn't need
  // a separate config here. If any required env is missing, publishEpochOnce
  // will log 'skip-no-summary' each cycle rather than crash.
  startPublishLoop();
  started.push('publish-epoch (24h)');
  return { started, skipped };
}
