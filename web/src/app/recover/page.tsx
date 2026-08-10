'use client';

/// /recover — one-stop recovery UI for anyone holding tokens on a bonding
/// curve whose CurveFactory is no longer wired into the launchpad app.
///
/// Buyers still own the ERC20 balance; the curve still holds their ETH;
/// sell() still works. The main app doesn't render these curves because
/// their factory isn't in CONTRACTS. This page bridges the gap.
///
/// Coverage proven by contracts/test/audit/OrphanRecoveryFork.t.sol —
/// impersonates a real URUFU holder against a live RH fork and confirms
/// approve + sell delivers ETH back.
///
/// Refresh the underlying list by re-running the sweep tool (see
/// lib/orphanCurves.ts docstring).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther, parseEther } from 'viem';
import { useAccount, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import {
    ORPHAN_CURVE_ABI,
    ORPHAN_CURVES,
    ORPHAN_TOKEN_ABI,
    SWEPT_AT_BLOCK,
    searchOrphans,
    type OrphanCurve,
} from '@/lib/orphanCurves';
import styles from './recover-page.module.css';

const RH_CHAIN_ID = CHAIN_KEY_TO_ID.robinhood;

export default function RecoverPage() {
    const [query, setQuery] = useState('');
    const results = useMemo(() => searchOrphans(query), [query]);
    const { isConnected } = useAccount();
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const showWalletHint = mounted && !isConnected && results.length > 0;

    const totalStuck = useMemo(() => {
        return ORPHAN_CURVES.reduce((acc, o) => acc + BigInt(o.balanceWeiAtSnapshot), 0n);
    }, []);

    return (
        <main className={styles.page}>
            <header className={styles.incidentHeader} aria-labelledby="recover-title">
                <div>
                    <p className={styles.eyebrow}>historical curve recovery</p>
                    <h1 id="recover-title" className={styles.title}>
                        Recovery Console
                    </h1>
                    <p className={styles.subtitle}>
                        This is an exceptional support flow for orphaned Robinhood Chain
                        bonding curves that no longer appear in the main launchpad UI.
                        It does not create a new trade, mint, launch, or migration.
                    </p>
                </div>
                <aside className={styles.safetyCard} aria-label="Recovery guardrails">
                    <span className={styles.noteKicker}>read before signing</span>
                    <b>approve, then sell back to the historical curve.</b>
                    <p>
                        The page reads your live token balance, asks for approval only when
                        needed, then calls <code>sell(tokensIn, 0)</code> on the old curve.
                        Nothing is broadcast until you confirm in your wallet.
                    </p>
                </aside>
            </header>

            <section className={styles.taskPanel} aria-label="Recovery task input">
                <div className={styles.reserveSummary}>
                    <span className={styles.noteKicker}>snapshot reserve hint</span>
                    <b>{Number(formatEther(totalStuck)).toFixed(4)} ETH</b>
                    <p>
                        across {ORPHAN_CURVES.length} orphan curves at RH block{' '}
                        <span className="uru-num">{SWEPT_AT_BLOCK}</span>. Each card refetches
                        live reserve and wallet balances.
                    </p>
                </div>
                <form className={styles.searchBlock} onSubmit={(e) => e.preventDefault()}>
                    <label htmlFor="orphan-search">1. Find historical token</label>
                    <input
                        id="orphan-search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="token name, symbol, token address, or curve address"
                        className={styles.searchInput}
                    />
                    {showWalletHint && (
                        <div className={styles.walletHint}>
                            connect wallet once to check which rows are yours and unlock recovery actions.
                        </div>
                    )}
                </form>
                <ol className={styles.stepList} aria-label="Recovery steps">
                    <li>
                        <span>2</span>
                        <p>Review the matching curve and live reserve.</p>
                    </li>
                    <li>
                        <span>3</span>
                        <p>Connect wallet on Robinhood Chain to read your balance.</p>
                    </li>
                    <li>
                        <span>4</span>
                        <p>Approve only the amount you choose, then sell back to the curve.</p>
                    </li>
                </ol>
            </section>

            {results.length === 0 ? (
                <div className={styles.empty}>
                    <span>no matching orphan curve</span>
                    <p>no orphaned curves match &quot;{query}&quot;.</p>
                </div>
            ) : (
                <section className={styles.results} aria-label="Matching orphan curves">
                    <div className={styles.resultsHeader}>
                        <span className={styles.noteKicker}>matching curves</span>
                        <b>{results.length}</b>
                    </div>
                    {results.map((o) => (
                        <OrphanCard key={o.curve} orphan={o} />
                    ))}
                </section>
            )}

            <details className={styles.help}>
                <summary>how recovery works + missing token help</summary>
                <div>
                    Connect your wallet and this page reads your token balance from Robinhood
                    Chain. If you hold one of these orphaned tokens, choose how much to sell.
                    You sign approve first if allowance is missing, then sign sell, and the
                    curve sends ETH back to your wallet.
                    <br />
                    <br />
                    Not seeing your token? The sweep covered historical Robinhood curve
                    factories. If your token is not listed, it may have graduated or may not
                    have launched through these contracts.{' '}
                    <Link href="/trade">Back to normal trading</Link>.
                </div>
            </details>
        </main>
    );
}

function OrphanCard({ orphan }: { orphan: OrphanCurve }) {
    // useAccount().chain reflects the wallet's ACTUAL connected chain (viem
    // Chain object). Falling back on useChainId() alone was flaky here —
    // wagmi's hook can return the config's default until the wallet finishes
    // syncing, which triggered a "switch chain" prompt even when the wallet
    // was already on RH. Trust chain.id when we have it.
    const { address: wallet, isConnected, chain: walletChain } = useAccount();
    const { switchChain, isPending: switching } = useSwitchChain();
    // If we don't know the wallet's chain yet, DON'T block on it — let the
    // useReadContract calls (which pin chainId={RH_CHAIN_ID}) resolve first.
    // Only prompt to switch if we *know* the wallet is on a different chain.
    const onRhChain = !walletChain || walletChain.id === RH_CHAIN_ID;

    // SSR guard — server always renders as if disconnected (wagmi state is
    // browser-only). Without this the first client paint diverges from the
    // server HTML the moment wagmi hydrates the wallet, triggering React's
    // hydration-mismatch error. Same pattern useActiveChain uses.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const effectiveIsConnected = mounted && isConnected;

    // Live curve ETH balance (fetch fresh — snapshot is just a hint).
    const curveEth = useReadContract({
        abi: ORPHAN_CURVE_ABI,
        address: orphan.curve,
        functionName: 'ethReserve',
        chainId: RH_CHAIN_ID,
    });
    const isGraduated = useReadContract({
        abi: ORPHAN_CURVE_ABI,
        address: orphan.curve,
        functionName: 'graduated',
        chainId: RH_CHAIN_ID,
    });

    // Holder's token balance + current allowance to the curve.
    const balanceQ = useReadContract({
        abi: ORPHAN_TOKEN_ABI,
        address: orphan.token,
        functionName: 'balanceOf',
        args: wallet ? [wallet] : undefined,
        chainId: RH_CHAIN_ID,
        query: { enabled: mounted && !!wallet, refetchInterval: 8000 },
    });
    const allowanceQ = useReadContract({
        abi: ORPHAN_TOKEN_ABI,
        address: orphan.token,
        functionName: 'allowance',
        args: wallet ? [wallet, orphan.curve] : undefined,
        chainId: RH_CHAIN_ID,
        query: { enabled: mounted && !!wallet, refetchInterval: 8000 },
    });

    const [amountInput, setAmountInput] = useState('');
    const parsedAmount = useMemo(() => {
        try {
            return amountInput ? parseEther(amountInput) : 0n;
        } catch {
            return 0n;
        }
    }, [amountInput]);

    // Distinguish "query still loading / errored" from "data returned 0n".
    // Collapsing them earlier meant a slow RPC or a transport error looked
    // identical to "you actually hold zero" — and the launcher wallet who
    // demonstrably holds 31M SPOOBS would still see "you don't hold any"
    // during the fetch window.
    const balanceData = balanceQ.data as bigint | undefined;
    const holderBalance = balanceData ?? 0n;
    const balanceKnown = balanceData !== undefined;
    const balanceErrored = !!balanceQ.error;
    const allowance = (allowanceQ.data as bigint | undefined) ?? 0n;
    const needsApprove = parsedAmount > 0n && allowance < parsedAmount;
    const hasEnoughTokens = parsedAmount > 0n && parsedAmount <= holderBalance;

    const {
        writeContractAsync,
        data: txHash,
        isPending: writing,
        error: writeErr,
    } = useWriteContract();
    const receipt = useWaitForTransactionReceipt({ hash: txHash });
    const [lastStep, setLastStep] = useState<'approve' | 'sell' | null>(null);

    async function onApprove() {
        setLastStep('approve');
        await writeContractAsync({
            abi: ORPHAN_TOKEN_ABI,
            address: orphan.token,
            functionName: 'approve',
            args: [orphan.curve, parsedAmount],
            chainId: RH_CHAIN_ID,
        });
    }

    async function onSell() {
        setLastStep('sell');
        await writeContractAsync({
            abi: ORPHAN_CURVE_ABI,
            address: orphan.curve,
            functionName: 'sell',
            args: [parsedAmount, 0n], // minEthOut = 0 keeps legacy recovery permissive; user still confirms wallet tx.
            chainId: RH_CHAIN_ID,
        });
    }

    const liveCurveEth = (curveEth.data as bigint | undefined) ?? BigInt(orphan.balanceWeiAtSnapshot);
    const graduated = (isGraduated.data as boolean | undefined) ?? false;
    const recoveryBlocked = graduated || liveCurveEth === 0n || !effectiveIsConnected || !onRhChain || balanceErrored || !balanceKnown || holderBalance === 0n;

    return (
        <article className={styles.card} data-blocked={recoveryBlocked ? 'true' : undefined}>
            <div className={styles.cardHeader}>
                <div>
                    <span className={styles.cardKicker}>orphan curve</span>
                    <h2>
                        {orphan.tokenName}{' '}
                        <span>({orphan.tokenSymbol})</span>
                    </h2>
                </div>
                <div className={styles.reserve}>
                    <span>ETH in curve</span>
                    <b>{Number(formatEther(liveCurveEth)).toFixed(4)}Ξ</b>
                </div>
            </div>

            <dl className={styles.addressGrid}>
                <div>
                    <dt>token</dt>
                    <dd>{orphan.token}</dd>
                </div>
                <div>
                    <dt>curve</dt>
                    <dd>{orphan.curve}</dd>
                </div>
                <div>
                    <dt>factory</dt>
                    <dd>{orphan.factory}</dd>
                </div>
            </dl>

            {graduated ? (
                <StateBox tone="mint">
                    this curve already graduated to a V4 pool. No recovery is needed here.
                    Use <Link href={`/trade/${orphan.token}`}>the normal trade page</Link> to swap.
                </StateBox>
            ) : liveCurveEth === 0n ? (
                <StateBox tone="paper">
                    curve is drained. There is no ETH left to recover from this historical curve.
                </StateBox>
            ) : !effectiveIsConnected ? (
                <StateBox tone="yolk">
                    connect wallet to check your live {orphan.tokenSymbol} balance and allowance.
                </StateBox>
            ) : !onRhChain ? (
                <button
                    onClick={() => switchChain({ chainId: RH_CHAIN_ID })}
                    disabled={switching}
                    className={styles.primaryButton}
                >
                    {switching ? 'switching...' : 'switch to robinhood chain'}
                </button>
            ) : balanceErrored ? (
                <StateBox tone="pink">
                    couldn&apos;t read your {orphan.tokenSymbol} balance:{' '}
                    <code>
                        {(balanceQ.error as Error | null)?.message?.split('\n')[0]?.slice(0, 220) ?? 'unknown'}
                    </code>
                    <small>
                        token {orphan.token} on robinhood (chain 4663). Try a hard refresh,
                        or check the browser console for the full error.
                    </small>
                </StateBox>
            ) : !balanceKnown ? (
                <StateBox tone="paper">checking your {orphan.tokenSymbol} balance...</StateBox>
            ) : holderBalance === 0n ? (
                <StateBox tone="paper">
                    you do not hold any {orphan.tokenSymbol}. Nothing to recover here.
                </StateBox>
            ) : (
                <div className={styles.actionPanel}>
                    <div className={styles.balanceLine}>
                        <span>your live balance</span>
                        <b>{Number(formatEther(holderBalance)).toLocaleString()} {orphan.tokenSymbol}</b>
                    </div>
                    <div className={styles.amountRow}>
                        <input
                            value={amountInput}
                            onChange={(e) => setAmountInput(e.target.value)}
                            placeholder="tokens to sell"
                            className={styles.amountInput}
                            disabled={writing || receipt.isLoading}
                        />
                        <button
                            type="button"
                            onClick={() => setAmountInput(formatEther(holderBalance))}
                            disabled={writing || receipt.isLoading}
                            className={styles.maxButton}
                        >
                            MAX
                        </button>
                    </div>

                    <button
                        onClick={needsApprove ? onApprove : onSell}
                        disabled={!hasEnoughTokens || writing || receipt.isLoading}
                        className={styles.primaryButton}
                        data-ready={hasEnoughTokens ? 'true' : undefined}
                    >
                        {!hasEnoughTokens
                            ? parsedAmount === 0n
                                ? 'enter amount'
                                : `not enough ${orphan.tokenSymbol}`
                            : writing
                              ? 'confirm in wallet...'
                              : receipt.isLoading
                                ? `${lastStep === 'approve' ? 'approving' : 'selling'}...`
                                : needsApprove
                                  ? `1/2 approve ${orphan.tokenSymbol}`
                                  : '2/2 sell for ETH'}
                    </button>

                    {receipt.isSuccess && lastStep === 'approve' && (
                        <StateBox tone="mint">
                            approval confirmed. If the button does not flip to sell yet,
                            wait for the allowance refresh.
                        </StateBox>
                    )}
                    {receipt.isSuccess && lastStep === 'sell' && (
                        <StateBox tone="mint">
                            sold. ETH landed in your wallet. Sell more or move on.
                        </StateBox>
                    )}
                    {writeErr && (
                        <StateBox tone="pink">
                            transaction failed:{' '}
                            {(writeErr as Error).message?.split('\n')[0]?.slice(0, 200) ?? 'unknown error'}
                        </StateBox>
                    )}
                </div>
            )}
        </article>
    );
}

function StateBox({
    tone,
    children,
}: {
    tone: 'pink' | 'mint' | 'yolk' | 'paper';
    children: React.ReactNode;
}) {
    return (
        <div className={styles.stateBox} data-tone={tone}>
            {children}
        </div>
    );
}
