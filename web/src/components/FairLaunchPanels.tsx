'use client';

/// Trade-page panels for Fair launch tokens (docs/SPEC-fair-launch.md):
///
///   - Before the batch settles: countdown, total ETH in, your deposit, your
///     estimated tokens at the current total, and a Deposit button.
///   - After it settles: a Claim button until you have claimed. The normal
///     curve UI on the page takes over from there.
///   - After graduation: a live sniper-tax chip ("Sniper tax: 12%, gone in 2:40")
///     and a dev badge ("Dev still holding, earns fees" / "Dev sold, their fees
///     now burn").
///
/// Renders nothing unless the active chain has a FairLaunchFactory configured
/// AND that factory knows this token, so it is invisible while the lane is dark.

import { useEffect, useMemo, useState } from 'react';
import { encodeAbiParameters, formatEther, keccak256, parseEther, type Address, type Hex } from 'viem';
import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

import { fairHookHostAbi, fairLaunchFactoryAbi, openingBatchAbi } from '@/lib/abis';
import { FAIR_LAUNCHES, type ChainKey } from '@/lib/config';
import { findDevFundedWallets } from '@/lib/devFunded';
import { fetchFairDepositors, fetchTradesForCurve } from '@/lib/indexer';
import type { WagmiChainId } from '@/lib/wagmi';
import info from './info-panel.module.css';
import styles from './FairLaunchPanels.module.css';

const ZERO = '0x0000000000000000000000000000000000000000';

interface Props {
  token: Address;
  chainKey: ChainKey | null;
  chainId: WagmiChainId;
  graduated: boolean;
}

/// ETH/token pool on the Fair hook: same fixed shape (3000 / 60) as every graduation.
function fairPoolId(token: Address, hook: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [ZERO, token, 3000, 60, hook],
    ),
  );
}

function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtEth(wei: bigint | undefined): string {
  if (wei === undefined) return '...';
  const n = Number(formatEther(wei));
  return n === 0 ? '0' : n < 0.0001 ? '<0.0001' : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtTokens(wei: bigint | undefined): string {
  if (wei === undefined) return '...';
  const n = Number(formatEther(wei));
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 4 : 0 });
}

export function FairLaunchPanels({ token, chainKey, chainId, graduated }: Props) {
  const set = chainKey ? FAIR_LAUNCHES[chainKey] : null;
  const { address: wallet } = useAccount();

  const batchQ = useReadContract({
    abi: fairLaunchFactoryAbi,
    address: set?.LaunchFactory,
    functionName: 'batchFor',
    args: [token],
    chainId,
    query: { enabled: !!set, staleTime: Infinity },
  });
  const batch = batchQ.data && batchQ.data !== ZERO ? (batchQ.data as Address) : null;

  const user = wallet ?? ZERO;
  const batchReads = useReadContracts({
    allowFailure: true,
    contracts: batch
      ? [
          { abi: openingBatchAbi, address: batch, functionName: 'closeTs', chainId },
          { abi: openingBatchAbi, address: batch, functionName: 'totalDeposited', chainId },
          { abi: openingBatchAbi, address: batch, functionName: 'settled', chainId },
          { abi: openingBatchAbi, address: batch, functionName: 'deposits', args: [user], chainId },
          { abi: openingBatchAbi, address: batch, functionName: 'claimed', args: [user], chainId },
          { abi: openingBatchAbi, address: batch, functionName: 'pending', args: [user], chainId },
          { abi: openingBatchAbi, address: batch, functionName: 'refundOwed', args: [user], chainId },
          { abi: openingBatchAbi, address: batch, functionName: 'creator', chainId },
        ]
      : [],
    query: { enabled: !!batch, refetchInterval: 5_000 },
  });
  const r = batchReads.data;
  const closeTs = r?.[0]?.result as bigint | undefined;
  const totalIn = r?.[1]?.result as bigint | undefined;
  const settled = r?.[2]?.result as boolean | undefined;
  const myDeposit = r?.[3]?.result as bigint | undefined;
  const myClaimed = r?.[4]?.result as boolean | undefined;
  const myPending = r?.[5]?.result as readonly [bigint, bigint] | undefined;
  const myRefundOwed = r?.[6]?.result as bigint | undefined;
  const creator = r?.[7]?.result as Address | undefined;

  const curveQ = useReadContract({
    abi: fairLaunchFactoryAbi,
    address: set?.LaunchFactory,
    functionName: 'curveFor',
    args: [token],
    chainId,
    query: { enabled: !!batch, staleTime: Infinity },
  });
  const curve = curveQ.data && curveQ.data !== ZERO ? (curveQ.data as Address) : null;

  // Wallets the dev funded (limit 1): batch depositors + early curve buyers that the
  // creator wallet sent ETH or this token to. Browser-side Blockscout read, warning only.
  const [funded, setFunded] = useState<{ flagged: string[]; checked: number } | null | 'unavailable'>(null);
  useEffect(() => {
    if (!batch || !creator || closeTs === undefined) return;
    let cancelled = false;
    (async () => {
      const [deps, trades] = await Promise.all([
        fetchFairDepositors(batch),
        curve ? fetchTradesForCurve(curve, 200) : Promise.resolve([]),
      ]);
      const early = (trades ?? []).filter((t) => t.isBuy).slice(0, 100).map((t) => t.trader);
      const candidates = [...new Set([...(deps ?? []), ...early].map((a) => a.toLowerCase()))];
      if (candidates.length === 0) {
        if (!cancelled) setFunded({ flagged: [], checked: 0 });
        return;
      }
      const flagged = await findDevFundedWallets({
        creator,
        token,
        launchTs: Number(closeTs),
        candidates,
        ignore: [batch, ...(curve ? [curve] : [])],
      });
      if (cancelled) return;
      setFunded(flagged === null ? 'unavailable' : { flagged, checked: candidates.length });
    })();
    return () => {
      cancelled = true;
    };
  }, [batch, creator, closeTs, curve, token]);

  const poolId = useMemo(() => (set && graduated ? fairPoolId(token, set.HookHost) : null), [set, graduated, token]);
  const hookReads = useReadContracts({
    allowFailure: true,
    contracts:
      set && poolId
        ? [
            { abi: fairHookHostAbi, address: set.HookHost, functionName: 'currentTaxBps', args: [poolId], chainId },
            { abi: fairHookHostAbi, address: set.HookHost, functionName: 'taxSecondsLeft', args: [poolId], chainId },
            { abi: fairHookHostAbi, address: set.HookHost, functionName: 'isForfeited', args: [poolId], chainId },
          ]
        : [],
    query: { enabled: !!poolId, refetchInterval: 10_000 },
  });
  const taxBps = hookReads.data?.[0]?.result as bigint | undefined;
  const taxLeft = hookReads.data?.[1]?.result as bigint | undefined;
  const forfeited = hookReads.data?.[2]?.result as boolean | undefined;

  // 1 s ticker so countdowns move between refetches.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  // Tax seconds were read at fetch time; count down locally from there.
  const [taxAnchor, setTaxAnchor] = useState<{ left: number; at: number } | null>(null);
  useEffect(() => {
    if (taxLeft !== undefined) setTaxAnchor({ left: Number(taxLeft), at: Math.floor(Date.now() / 1000) });
  }, [taxLeft]);

  const [amount, setAmount] = useState('');
  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash, chainId });
  useEffect(() => {
    if (!isSuccess) return;
    void batchReads.refetch();
    setAmount('');
    reset();
  }, [isSuccess, batchReads, reset]);

  if (!set || !batch) return null;

  const busy = isPending || confirming;
  const windowOpen = closeTs !== undefined && now < Number(closeTs) && !settled;
  const parsed = (() => {
    try {
      return amount ? parseEther(amount) : 0n;
    } catch {
      return 0n;
    }
  })();

  const deposit = () =>
    writeContract({ abi: openingBatchAbi, address: batch, functionName: 'deposit', value: parsed, chainId });
  const claim = () => writeContract({ abi: openingBatchAbi, address: batch, functionName: 'claim', chainId });
  const settle = () => writeContract({ abi: openingBatchAbi, address: batch, functionName: 'settle', chainId });
  const withdrawRefund = () =>
    wallet &&
    writeContract({ abi: openingBatchAbi, address: batch, functionName: 'withdrawRefund', args: [wallet], chainId });

  const taxSecs = taxAnchor ? Math.max(0, taxAnchor.left - (now - taxAnchor.at)) : 0;
  const taxPct = taxBps !== undefined ? Number(taxBps) / 100 : 0;

  return (
    <>
      {graduated && (
        <div className={styles.chips}>
          {taxBps !== undefined && taxBps > 0n && taxSecs > 0 && (
            <span className={styles.chip} data-tone="warn" title="Extra fee right after the pool opens. It is burned, nobody gets it.">
              Sniper tax: {taxPct.toFixed(taxPct < 1 ? 2 : 0)}%, gone in {clock(taxSecs)}
            </span>
          )}
          {forfeited !== undefined && (
            <span
              className={styles.chip}
              data-tone={forfeited ? 'bad' : 'ok'}
              title="Only the launch wallet is tracked. A dev who also bought from other wallets can't be caught on-chain."
            >
              {forfeited ? 'Dev sold, their fees now burn' : 'Dev still holding, earns fees'}
            </span>
          )}
        </div>
      )}

      {funded !== null && (funded === 'unavailable' || funded.checked > 0) && (
        <p className={styles.fundedNote} data-tone={funded !== 'unavailable' && funded.flagged.length > 0 ? 'bad' : undefined}>
          {funded === 'unavailable'
            ? 'Dev-funded wallet check is unavailable right now.'
            : funded.flagged.length > 0
              ? `Heads up: ${funded.flagged.length} of ${funded.checked} early buyers got ETH or tokens from the dev wallet.`
              : funded.checked > 0
                ? `No early buyers got ETH or tokens from the dev wallet (${funded.checked} checked).`
                : null}
          {funded !== 'unavailable' && funded.flagged.length > 0 && (
            <span className={styles.fundedList}>
              {funded.flagged.slice(0, 8).map((a) => (
                <a key={a} href={`https://robinhoodchain.blockscout.com/address/${a}`} target="_blank" rel="noreferrer">
                  {a.slice(0, 6)}...{a.slice(-4)}
                </a>
              ))}
            </span>
          )}
          <small>Only catches direct sends from the launch wallet, not exchanges or hops.</small>
        </p>
      )}

      {myRefundOwed !== undefined && myRefundOwed > 0n && (
        <section className={info.block}>
          <p className={info.muted}>
            {fmtEth(myRefundOwed)} ETH from your batch refund could not be sent automatically. Withdraw it to
            your connected wallet.
          </p>
          <button type="button" className="ui-btn" disabled={!wallet || busy} onClick={withdrawRefund}>
            {busy ? 'Withdrawing...' : 'Withdraw refund'}
          </button>
        </section>
      )}

      {!graduated && (windowOpen || !settled || (myDeposit !== undefined && myDeposit > 0n && !myClaimed)) && (
        <section className={info.block}>
          <div className={info.head}>
            <p className={info.label}>Opening batch</p>
            <span className={info.sub}>
              {windowOpen
                ? `Closes in ${clock(Number(closeTs) - now)}`
                : settled
                  ? 'Filled. Everyone paid the same price.'
                  : 'Window closed. The first trade fills it.'}
            </span>
          </div>

          <p className={info.muted}>
            Every deposit in the first minute buys at one shared price. Your tokens are your share of
            the total, so splitting across wallets or getting in first earns nothing extra.
          </p>

          <div className={info.stats}>
            <Stat label="Total in" value={`${fmtEth(totalIn)} ETH`} />
            <Stat label="Your deposit" value={`${fmtEth(myDeposit)} ETH`} />
            <Stat
              label={settled ? 'Your tokens' : 'Est. tokens now'}
              value={myPending ? fmtTokens(myPending[0]) : '...'}
            />
            {myPending && myPending[1] > 0n && <Stat label="ETH refund" value={`${fmtEth(myPending[1])} ETH`} />}
          </div>

          {windowOpen && (
            <div className={styles.row}>
              <input
                className="ui-input"
                inputMode="decimal"
                placeholder="0.1"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                aria-label="ETH to deposit"
              />
              <button
                type="button"
                className="ui-btn"
                data-variant="primary"
                disabled={!wallet || busy || parsed === 0n}
                onClick={deposit}
              >
                {busy ? 'Depositing...' : 'Deposit'}
              </button>
            </div>
          )}

          {!windowOpen && !settled && (
            <button type="button" className="ui-btn" disabled={!wallet || busy} onClick={settle}>
              {busy ? 'Filling...' : 'Fill the batch now'}
            </button>
          )}

          {settled && myDeposit !== undefined && myDeposit > 0n && !myClaimed && (
            <button type="button" className="ui-btn" data-variant="primary" disabled={!wallet || busy} onClick={claim}>
              {busy ? 'Claiming...' : 'Claim'}
            </button>
          )}

          {writeError && <p className={styles.error}>{writeError.message.split('\n')[0]}</p>}
          {!wallet && <p className={info.muted}>Connect a wallet to deposit or claim.</p>}
        </section>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={info.stat}>
      <span className={info.statLabel}>{label}</span>
      <span className={info.statValue}>{value}</span>
    </div>
  );
}
