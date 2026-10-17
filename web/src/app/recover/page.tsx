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
                    <p className={styles.eyebrow}>Recover ETH</p>
                    <h1 id="recover-title" className={styles.title}>
                        Sell back to an old curve
                    </h1>
                    <p className={styles.subtitle}>
                        A few early coins were launched on curves that no longer show in the app.
                        If you still hold one, you can sell it back to its curve here and get ETH
                        back. Nothing new is launched or traded.
                    </p>
                </div>
                <aside className={styles.safetyCard} aria-label="Recovery guardrails">
                    <span className={styles.noteKicker}>Read before signing</span>
                    <b>Approve, then sell back to the old curve.</b>
                    <p>
                        The page reads your current token balance, asks for approval only when
                        it&apos;s needed, then sells your tokens back to the old curve. Nothing is
                        sent until you confirm in your wallet.
                    </p>
                </aside>
            </header>

            <section className={styles.taskPanel} aria-label="Recovery task input">
                <div className={styles.reserveSummary}>
                    <span className={styles.noteKicker}>ETH left on old curves</span>
                    <b>{Number(formatEther(totalStuck)).toFixed(4)} ETH</b>
                    <p>
                        Across {ORPHAN_CURVES.length} old curves, as of Robinhood Chain block{' '}
                        <span className="uru-num">{SWEPT_AT_BLOCK}</span>. Each card below shows the
                        live amount and your balance.
                    </p>
                </div>
                <form className={styles.searchBlock} onSubmit={(e) => e.preventDefault()}>
                    <label htmlFor="orphan-search">1. Find your token</label>
                    <input
                        id="orphan-search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Token name, ticker, token address or curve address"
                        className={styles.searchInput}
                    />
                    {showWalletHint && (
                        <div className={styles.walletHint}>
                            Connect your wallet to see which of these you hold and to sell them back.
                        </div>
                    )}
                </form>
                <ol className={styles.stepList} aria-label="Recovery steps">
                    <li>
                        <span>2</span>
                        <p>Check the matching curve and how much ETH it still holds.</p>
                    </li>
                    <li>
                        <span>3</span>
                        <p>Connect your wallet on Robinhood Chain to see your balance.</p>
                    </li>
                    <li>
                        <span>4</span>
                        <p>Approve only the amount you choose, then sell back to the curve.</p>
                    </li>
                </ol>
            </section>

            {results.length === 0 ? (
                <div className={styles.empty}>
                    <span>No matching curve</span>
                    <p>No old curves match &quot;{query}&quot;.</p>
                </div>
            ) : (
                <section className={styles.results} aria-label="Matching orphan curves">
                    <div className={styles.resultsHeader}>
                        <span className={styles.noteKicker}>Matching curves</span>
                        <b>{results.length}</b>
                    </div>
                    {results.map((o) => (
                        <OrphanCard key={o.curve} orphan={o} />
                    ))}
                </section>
            )}

            <details className={styles.help}>
                <summary>How this works, and what to do if your token is missing</summary>
                <div>
                    Connect your wallet and this page reads your token balance from Robinhood
                    Chain. If you hold one of these old tokens, choose how much to sell. You
                    first approve the sale (only if you haven&apos;t already), then sign the sell,
                    and the curve sends ETH back to your wallet.
                    <br />
                    <br />
                    Not seeing your token? This list covers the old Robinhood Chain curves. If
                    your token isn&apos;t here, it may have graduated, or it wasn&apos;t launched
                    through these contracts.{' '}
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
                    <span className={styles.cardKicker}>Old curve</span>
                    <h2>
                        {orphan.tokenName}{' '}
                        <span>({orphan.tokenSymbol})</span>
                    </h2>
                </div>
                <div className={styles.reserve}>
                    <span>ETH in curve</span>
                    <b>{Number(formatEther(liveCurveEth)).toFixed(4)} ETH</b>
                </div>
            </div>

            <dl className={styles.addressGrid}>
                <div>
                    <dt>Token</dt>
                    <dd>{orphan.token}</dd>
                </div>
                <div>
                    <dt>Curve</dt>
                    <dd>{orphan.curve}</dd>
                </div>
                <div>
                    <dt>Factory</dt>
                    <dd>{orphan.factory}</dd>
                </div>
            </dl>

            {graduated ? (
                <StateBox tone="mint">
                    This curve already graduated to a Uniswap v4 pool, so nothing needs recovering here.
                    Use <Link href={`/trade/${orphan.token}`}>the normal trade page</Link> to swap.
                </StateBox>
            ) : liveCurveEth === 0n ? (
                <StateBox tone="paper">
                    This curve is empty. There is no ETH left to recover from it.
                </StateBox>
            ) : !effectiveIsConnected ? (
                <StateBox tone="yolk">
                    Connect your wallet to check your {orphan.tokenSymbol} balance.
                </StateBox>
            ) : !onRhChain ? (
                <button
                    onClick={() => switchChain({ chainId: RH_CHAIN_ID })}
                    disabled={switching}
                    className={styles.primaryButton}
                >
                    {switching ? 'Switching…' : 'Switch to Robinhood Chain'}
                </button>
            ) : balanceErrored ? (
                <StateBox tone="pink">
                    Couldn&apos;t read your {orphan.tokenSymbol} balance:{' '}
                    <code>
                        {(balanceQ.error as Error | null)?.message?.split('\n')[0]?.slice(0, 220) ?? 'unknown'}
                    </code>
                    <small>
                        Token {orphan.token} on Robinhood Chain (chain ID 4663). Try a hard refresh,
                        or check the browser console for the full error.
                    </small>
                </StateBox>
            ) : !balanceKnown ? (
                <StateBox tone="paper">Checking your {orphan.tokenSymbol} balance…</StateBox>
            ) : holderBalance === 0n ? (
                <StateBox tone="paper">
                    You don&apos;t hold any {orphan.tokenSymbol}, so there&apos;s nothing to recover here.
                </StateBox>
            ) : (
                <div className={styles.actionPanel}>
                    <div className={styles.balanceLine}>
                        <span>Your balance</span>
                        <b>{Number(formatEther(holderBalance)).toLocaleString()} {orphan.tokenSymbol}</b>
                    </div>
                    <div className={styles.amountRow}>
                        <input
                            value={amountInput}
                            onChange={(e) => setAmountInput(e.target.value)}
                            placeholder="Tokens to sell"
                            className={styles.amountInput}
                            disabled={writing || receipt.isLoading}
                        />
                        <button
                            type="button"
                            onClick={() => setAmountInput(formatEther(holderBalance))}
                            disabled={writing || receipt.isLoading}
                            className={styles.maxButton}
                        >
                            Max
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
                                ? 'Enter an amount'
                                : `Not enough ${orphan.tokenSymbol}`
                            : writing
                              ? 'Confirm in your wallet…'
                              : receipt.isLoading
                                ? `${lastStep === 'approve' ? 'Approving' : 'Selling'}…`
                                : needsApprove
                                  ? `Approve ${orphan.tokenSymbol} (1 of 2)`
                                  : 'Sell for ETH (2 of 2)'}
                    </button>

                    {receipt.isSuccess && lastStep === 'approve' && (
                        <StateBox tone="mint">
                            Approval confirmed. If the button doesn&apos;t switch to Sell yet, give it a few seconds to
                            refresh.
                        </StateBox>
                    )}
                    {receipt.isSuccess && lastStep === 'sell' && (
                        <StateBox tone="mint">
                            Sold. The ETH is in your wallet.
                        </StateBox>
                    )}
                    {writeErr && (
                        <StateBox tone="pink">
                            Transaction failed:{' '}
                            {(writeErr as Error).message?.split('\n')[0]?.slice(0, 200) ?? 'Unknown error'}
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
