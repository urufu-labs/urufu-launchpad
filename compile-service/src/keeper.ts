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
///  3. **activateEpochLoop** (every 30 min)
///     Round-2 audit FINDING 1. Reads `NftRevenueVault.pendingEpoch()`; if a
///     proposal is on-chain and its timelock has elapsed, sends
///     `activateEpoch()`. Cheap (single read + occasional tx), idempotent
///     (no-op when nothing is pending), and mandatory for the vault's
///     production `minConfigDelay > 0` mode — without it, propose-path
///     epochs sit un-activated forever and claims never open.
///
/// All loops are:
///   - Opt-in via `KEEPER_ENABLED=true` — off by default so local dev + PR
///     previews don't accidentally publish epochs against prod state.
///   - Idempotent — safe to run twice in a row. `pushOwed` reverts with
///     `NothingToClaim` if owed==0 (caught + logged); `publishEpoch` is
///     gated by a minimum-balance threshold; `activateVaultEpoch` returns
///     null when there's nothing to activate.
///   - Log-friendly — every action prints a single JSON-shaped line so
///     Railway logs stay grep-able.

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { activateVaultEpoch, publishEpoch, vaultSummary } from './rewards.ts';

/// Contract wiring — MultiHookHost + FeeSplitter for the sweep leg. The
/// publish leg reuses `rewards.ts` which reads its own env.
const MHH_ABI = parseAbi([
  'function owed(address currency, address who) view returns (uint256)',
  'function pushOwed(address currency, address account) external',
]);

interface SweepConfig {
  chainId: number;
  rpcUrl: string;
  /// Every live MHH we still need to sweep. After a MHH rotation, keep the OLD
  /// address in this list until every pool on it is drained (or user is fine
  /// with residual fees stranded there).
  multiHookHosts: Address[];
  feeSplitter: Address;
  keeperKey: Hex;
}

/// Parse `ROBINHOOD_MULTI_HOOK_HOST_ADDRESS` as either a single address (the
/// legacy shape) or comma-separated addresses. The keeper sweeps each one
/// independently every tick so a MHH rotation doesn't strand fees on the old
/// hook.
///
/// Example values on RH today:
///   "0x83d6fa59...E0C4,0x48C22af8...E0C4"   (V11 + V10 — sweep both)
///   "0x83d6fa59...E0C4"                       (V11 only — legacy pool fees strand)
function parseMultiHookHosts(raw: string | undefined): Address[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as Address[];
}

function sweepConfig(): SweepConfig | null {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const multiHookHosts = parseMultiHookHosts(process.env.ROBINHOOD_MULTI_HOOK_HOST_ADDRESS);
  const feeSplitter = process.env.ROBINHOOD_FEE_SPLITTER_ADDRESS as Address | undefined;
  const rawKey = process.env.KEEPER_PRIVATE_KEY;
  if (!rpcUrl || multiHookHosts.length === 0 || !feeSplitter || !rawKey) return null;
  const keeperKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  return { chainId: 4663, rpcUrl, multiHookHosts, feeSplitter, keeperKey };
}

const ETH_CURRENCY: Address = '0x0000000000000000000000000000000000000000';

/// How much accrued ETH is worth sweeping. Sub-dust amounts cost more in gas
/// than the swept value; anything above this threshold justifies the tx.
/// Tune down if trading picks up and you want faster reflection in the vault.
const MHH_SWEEP_THRESHOLD_WEI = 10_000_000_000_000n; // 0.00001 ETH ~= a few cents

async function sweepOneMhh(cfg: SweepConfig, mhh: Address, pub: ReturnType<typeof createPublicClient>): Promise<void> {
  const owed = (await pub.readContract({
    address: mhh,
    abi: MHH_ABI,
    functionName: 'owed',
    args: [ETH_CURRENCY, cfg.feeSplitter],
  })) as bigint;

  if (owed < MHH_SWEEP_THRESHOLD_WEI) {
    console.log(JSON.stringify({ keeper: 'sweep-mhh', mhh, action: 'skip', owed: owed.toString(), threshold: MHH_SWEEP_THRESHOLD_WEI.toString() }));
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
    address: mhh,
    abi: MHH_ABI,
    functionName: 'pushOwed',
    args: [ETH_CURRENCY, cfg.feeSplitter],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  console.log(JSON.stringify({ keeper: 'sweep-mhh', mhh, action: 'swept', owed: owed.toString(), tx: hash, status: receipt.status }));
}

async function sweepMhhToFeeSplitterOnce(cfg: SweepConfig): Promise<void> {
  const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
  // Sweep each MHH independently — one MHH's failure (NothingToClaim,
  // transient RPC blip, etc) never blocks another MHH's sweep this tick.
  for (const mhh of cfg.multiHookHosts) {
    try {
      await sweepOneMhh(cfg, mhh, pub);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('NothingToClaim')) {
        continue;
      }
      console.log(JSON.stringify({ keeper: 'sweep-mhh', mhh, action: 'error', error: msg }));
    }
  }
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
    // Round-2 audit FINDING 1: `publishEpoch` now returns a discriminated
    // outcome — a matured pending proposal is activated in place, an immature
    // one is a no-op for this cycle, everything else is a fresh publish.
    // Prior code always logged "published" which lied when the vault had a
    // real timelock configured.
    const outcome = await publishEpoch({ chainSlug: 'robinhood' });
    if (outcome.action === 'published') {
      console.log(JSON.stringify({
        keeper: 'publish-epoch', action: 'published',
        epochId: outcome.epochId, totalAmount: outcome.totalAmount,
        holderCount: outcome.holderCount, tx: outcome.txHash,
      }));
    } else if (outcome.action === 'activated') {
      console.log(JSON.stringify({
        keeper: 'publish-epoch', action: 'activated-pending',
        epochId: outcome.epochId, tx: outcome.txHash,
      }));
    } else {
      console.log(JSON.stringify({
        keeper: 'publish-epoch', action: 'skip-immature-proposal',
        epochId: outcome.epochId, readyAt: outcome.readyAt,
      }));
    }
  } catch (err) {
    console.log(JSON.stringify({ keeper: 'publish-epoch', action: 'failed', error: (err as Error).message }));
  }
}

/// Round-2 audit FINDING 1 AC #4: activation loop. Reads the vault's
/// `pendingEpoch()`; if matured, calls `activateEpoch`. Any propose that
/// lands on-chain — whether from our keeper's own publish leg or an
/// out-of-band operator tx — is picked up and activated automatically once
/// the timelock elapses.
async function activateEpochOnce(): Promise<void> {
  try {
    const result = await activateVaultEpoch('robinhood');
    if (!result) {
      console.log(JSON.stringify({ keeper: 'activate-epoch', action: 'skip-no-mature-pending' }));
      return;
    }
    console.log(JSON.stringify({
      keeper: 'activate-epoch', action: 'activated',
      epochId: result.epochId, tx: result.txHash,
    }));
  } catch (err) {
    console.log(JSON.stringify({ keeper: 'activate-epoch', action: 'failed', error: (err as Error).message }));
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

// ============================================================
// URU BUYBACK LOOP (4th keeper loop, added 2026-08-12)
// ============================================================
// Reads UruBuybackVault balance; if > BUYBACK_MIN_ETH_THRESHOLD, computes
// minUruOut from live URU/WETH pool spot with a slippage buffer, encodes a
// UniversalRouter execute() call for WRAP_ETH + V4_SWAP(WETH→URU), and
// invokes vault.executeBuyback(UR, ethIn, swapData, minUruOut). Vault
// auto-forwards received URU to distributionSink (NftRevenueVault) for
// gemu holder rewards.
//
// Proof this encoding works on-chain: contracts/script/UruBuybackFirst.s.sol
// broadcast 2026-08-12, 0.048 ETH → 137,457 URU delivered to NftRevenueVault.

const URU_BUYBACK_ABI = parseAbi([
  'function executeBuyback(address swapTarget, uint256 ethIn, bytes calldata swapData, uint256 minUruOut) external',
  'function distributionSink() view returns (address)',
  'function minUruPerEth() view returns (uint256)',
  'function isKeeper(address) view returns (bool)',
  'function isSwapTarget(address) view returns (bool)',
]);

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable',
]);

// v4-periphery Actions enum values used below.
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE = 0x0b;
const ACTION_TAKE_ALL = 0x0f;

// UR command bytes.
const CMD_WRAP_ETH: Hex = '0x0b';
const CMD_V4_SWAP: Hex = '0x10';

// Special recipient constants understood by UR.
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';

interface BuybackConfig {
  chainId: number;
  rpcUrl: string;
  vault: Address;
  universalRouter: Address;
  poolManager: Address;
  stateView: Address;
  weth: Address;
  uru: Address;
  uruPoolHook: Address;
  uruPoolFee: number;
  uruPoolTickSpacing: number;
  keeperKey: Hex;
  slippageBps: number;
}

function buybackConfig(): BuybackConfig | null {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const vault = process.env.ROBINHOOD_URU_BUYBACK_VAULT_ADDRESS as Address | undefined;
  const rawKey = process.env.KEEPER_PRIVATE_KEY;
  if (!rpcUrl || !vault || !rawKey) return null;
  const keeperKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  // Post-migration Robinhood v4 addresses — pinned per project_robinhood_addresses.
  return {
    chainId: 4663,
    rpcUrl,
    vault,
    universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
    poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    uru: '0x9fbe210007dDd8389f98d0253018e65CC48b9D24',
    uruPoolHook: '0x8933d28E68d02FaA02436aeF42E6ba9674698044',
    uruPoolFee: 3000,
    uruPoolTickSpacing: 60,
    keeperKey,
    slippageBps: 200, // 2%
  };
}

/// Skip buyback if vault holds less than this much ETH. Sub-dust buybacks
/// waste more in gas than they'd yield in URU. Tune down when volume grows.
const BUYBACK_MIN_ETH_THRESHOLD_WEI = 10_000_000_000_000_000n; // 0.01 ETH

/// Compute the URU/WETH v4 poolId from the fixed pool key.
function uruPoolId(cfg: BuybackConfig): Hex {
  // v4 poolId = keccak(abi.encode(PoolKey)) — encode currency0, currency1, fee, tickSpacing, hooks in that order.
  const encoded = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'uint24' },
      { type: 'int24' },
      { type: 'address' },
    ],
    [cfg.weth, cfg.uru, cfg.uruPoolFee, cfg.uruPoolTickSpacing, cfg.uruPoolHook],
  );
  // keccak256 from viem
  const { keccak256 } = require('viem') as typeof import('viem');
  return keccak256(encoded);
}

/// Compute expected URU output for a given ETH input at current pool spot,
/// then subtract slippage buffer to get minUruOut. BigInt math avoids the
/// uint256 overflow the on-chain Solidity script hit with sqrtPriceX96^2.
function computeMinUruOut(sqrtPriceX96: bigint, ethIn: bigint, slippageBps: number): bigint {
  // price18 (URU per WETH, 18-dec fixed) = sqrtPriceX96^2 * 1e18 / 2^192
  const price18 = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n;
  const naive = (ethIn * price18) / 10n ** 18n;
  return (naive * BigInt(10_000 - slippageBps)) / 10_000n;
}

/// Encode the UR execute() calldata for WRAP_ETH + V4_SWAP(WETH→URU).
/// TAKE_ALL delivers URU directly to msg.sender (= UruBuybackVault).
function encodeBuybackSwap(cfg: BuybackConfig, ethIn: bigint, minUruOut: bigint, deadline: bigint): Hex {
  const commands = ('0x' + CMD_WRAP_ETH.slice(2) + CMD_V4_SWAP.slice(2)) as Hex;

  // input 0: WRAP_ETH(recipient, amount)
  const wrapInput = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [ADDRESS_THIS, ethIn],
  );

  // input 1: V4_SWAP(bytes actions, bytes[] params)
  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE, ACTION_TAKE_ALL],
  );
  // SWAP_EXACT_IN_SINGLE params (RH v4-periphery struct has 6 fields incl. minHopPriceX36).
  const swapParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'minHopPriceX36', type: 'uint256' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [
      {
        poolKey: {
          currency0: cfg.weth,
          currency1: cfg.uru,
          fee: cfg.uruPoolFee,
          tickSpacing: cfg.uruPoolTickSpacing,
          hooks: cfg.uruPoolHook,
        },
        zeroForOne: true,
        amountIn: ethIn,
        amountOutMinimum: minUruOut,
        minHopPriceX36: 0n,
        hookData: '0x',
      },
    ],
  );
  // SETTLE(currency, amount, payerIsUser=false) — router pays WETH from its own balance.
  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
    [cfg.weth, ethIn, false],
  );
  // TAKE_ALL(currency, minAmount) — delivers URU to msg.sender (UruBuybackVault).
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [cfg.uru, minUruOut],
  );

  const v4SwapInput = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [swapParams, settleParams, takeParams]],
  );

  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [commands, [wrapInput, v4SwapInput], deadline],
  });
}

async function uruBuybackOnce(cfg: BuybackConfig): Promise<void> {
  const pub = createPublicClient({ transport: http(cfg.rpcUrl) });

  // 1. Read vault ETH balance.
  const vaultBal = await pub.getBalance({ address: cfg.vault });
  if (vaultBal < BUYBACK_MIN_ETH_THRESHOLD_WEI) {
    console.log(JSON.stringify({
      keeper: 'uru-buyback', action: 'skip-low-balance',
      vaultBalance: vaultBal.toString(),
      threshold: BUYBACK_MIN_ETH_THRESHOLD_WEI.toString(),
    }));
    return;
  }

  // 2. Sanity: UR allowlisted + keeper key is allowed.
  const account = privateKeyToAccount(cfg.keeperKey);
  const [urAllowed, keeperAllowed] = await Promise.all([
    pub.readContract({
      address: cfg.vault, abi: URU_BUYBACK_ABI, functionName: 'isSwapTarget', args: [cfg.universalRouter],
    }) as Promise<boolean>,
    pub.readContract({
      address: cfg.vault, abi: URU_BUYBACK_ABI, functionName: 'isKeeper', args: [account.address],
    }) as Promise<boolean>,
  ]);
  if (!urAllowed) {
    console.log(JSON.stringify({ keeper: 'uru-buyback', action: 'skip-ur-not-allowlisted' }));
    return;
  }
  if (!keeperAllowed) {
    console.log(JSON.stringify({ keeper: 'uru-buyback', action: 'skip-wallet-not-keeper', wallet: account.address }));
    return;
  }

  // 3. Fetch live pool spot to size minUruOut.
  const poolId = uruPoolId(cfg);
  const slot0 = await pub.readContract({
    address: cfg.stateView, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId],
  }) as readonly [bigint, number, number, number];
  const sqrtPriceX96 = slot0[0];
  const minUruOut = computeMinUruOut(sqrtPriceX96, vaultBal, cfg.slippageBps);

  // 4. Encode UR calldata + broadcast executeBuyback.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const swapData = encodeBuybackSwap(cfg, vaultBal, minUruOut, deadline);

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
    address: cfg.vault,
    abi: URU_BUYBACK_ABI,
    functionName: 'executeBuyback',
    args: [cfg.universalRouter, vaultBal, swapData, minUruOut],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  console.log(JSON.stringify({
    keeper: 'uru-buyback', action: 'executed',
    ethIn: vaultBal.toString(), minUruOut: minUruOut.toString(),
    tx: hash, status: receipt.status,
  }));
}

/// URU buyback loop — 24 h cadence. First run 15 min after boot to stay out
/// of the way of publish + sweep first runs. Idempotent: skip when balance
/// is below threshold or config is missing. Reverts (typically slippage or
/// pool moved) are caught and logged; next cycle retries with fresh state.
function startBuybackLoop(): void {
  const cfg = buybackConfig();
  const runSafely = async () => {
    if (!cfg) {
      console.log(JSON.stringify({ keeper: 'uru-buyback', action: 'skip-no-config' }));
      return;
    }
    try {
      await uruBuybackOnce(cfg);
    } catch (err) {
      console.log(JSON.stringify({
        keeper: 'uru-buyback', action: 'error', error: (err as Error).message,
      }));
    }
  };
  setTimeout(runSafely, 15 * 60 * 1000);
  setInterval(runSafely, 24 * 60 * 60 * 1000);
}

/// Round-2 audit FINDING 1 AC #4: activation loop — 30 min cadence.
/// Activation is cheap (one small read + one small tx when matured) and
/// idempotent (`activateVaultEpoch` returns null when there's nothing to
/// do). First run 10 min after boot so we don't fight the publish loop's
/// first run.
function startActivationLoop(): void {
  const runSafely = async () => {
    try {
      await activateEpochOnce();
    } catch (err) {
      console.log(JSON.stringify({ keeper: 'activate-epoch', action: 'error', error: (err as Error).message }));
    }
  };
  setTimeout(runSafely, 10 * 60 * 1000);
  setInterval(runSafely, 30 * 60 * 1000);
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
  // Publish + activation loops reuse env from rewards.ts (chainConfigFor)
  // and don't need a separate config here. If any required env is missing,
  // they log a skip line each cycle rather than crash.
  startPublishLoop();
  started.push('publish-epoch (24h)');
  startActivationLoop();
  started.push('activate-epoch (30min)');
  // URU buyback: reads UruBuybackVault balance and, if above the threshold,
  // executes a swap on the URU/WETH v4 pool via UniversalRouter. Received URU
  // auto-forwards to UruBuybackVault.distributionSink for downstream handling.
  // Depends on ROBINHOOD_URU_BUYBACK_VAULT_ADDRESS + KEEPER_PRIVATE_KEY +
  // ROBINHOOD_RPC_URL; skips a cycle if any is missing.
  // Also gated by URU_BUYBACK_ENABLED to prevent stranding URU while the
  // distributionSink is being rotated (proposeDistributionSink → 2-day
  // timelock → activateDistributionSink). Enable only after the target sink
  // has a functional URU-handling path (either 0xdEaD for burn, or a
  // distribution vault). Default off for safety.
  if (process.env.URU_BUYBACK_ENABLED !== 'true') {
    skipped.push('uru-buyback (URU_BUYBACK_ENABLED != true — set after distributionSink rotation activates)');
  } else if (buybackConfig()) {
    startBuybackLoop();
    started.push('uru-buyback (24h)');
  } else {
    skipped.push('uru-buyback (missing env: ROBINHOOD_RPC_URL / _URU_BUYBACK_VAULT_ADDRESS / KEEPER_PRIVATE_KEY)');
  }
  return { started, skipped };
}
