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
import { bondingCurveAbi, erc20TokenAbi } from '@/lib/abis';
import { ORPHAN_CURVES, SWEPT_AT_BLOCK, searchOrphans, type OrphanCurve } from '@/lib/orphanCurves';

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
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px' }}>
            <h1
                className="uru-h1"
                style={{ fontSize: 28, marginBottom: 8, color: 'var(--pink-hot)' }}
            >
                ✿ recover ur eth
            </h1>
            <p style={{ fontSize: 13, color: 'var(--anchor)', marginBottom: 16, lineHeight: 1.5 }}>
                old curve launches no longer show in the main ui. if u bought one, sell back here
                and recover the eth still sitting in the curve.
            </p>
            <div
                style={{
                    fontSize: 12,
                    background: 'var(--paper-white, #fff)',
                    border: '1.5px dashed var(--anchor)',
                    padding: 10,
                    borderRadius: 6,
                    marginBottom: 16,
                    color: 'var(--anchor)',
                }}
            >
                <div>total eth still recoverable: <b>{Number(formatEther(totalStuck)).toFixed(4)} ETH</b> across {ORPHAN_CURVES.length} curves</div>
                <div style={{ opacity: 0.65, marginTop: 4 }}>snapshot @ RH block {SWEPT_AT_BLOCK}. live balances refetched below.</div>
            </div>

            <label
                style={{ display: 'block', fontSize: 12, color: 'var(--anchor)', marginBottom: 4 }}
            >
                search by token name, symbol, or address
            </label>
            <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. URUFU, spoobs, 0x522c..."
                style={{
                    width: '100%',
                    padding: 10,
                    fontSize: 14,
                    border: '2px solid var(--anchor)',
                    borderRadius: 6,
                    background: 'var(--paper-white, #fff)',
                    color: 'var(--anchor)',
                    marginBottom: 16,
                }}
            />

            {showWalletHint && (
                <div
                    style={{
                        padding: '8px 10px',
                        background: 'var(--cream-deep)',
                        border: '1.5px dashed var(--anchor)',
                        borderRadius: 6,
                        fontSize: 12,
                        color: 'var(--anchor-soft)',
                        marginBottom: 16,
                    }}
                >
                    connect wallet once to check which rows are yours and unlock recovery actions.
                </div>
            )}

            {results.length === 0 ? (
                <div
                    style={{
                        padding: 20,
                        textAlign: 'center',
                        color: 'var(--anchor-soft)',
                        border: '1.5px dashed var(--anchor)',
                        borderRadius: 6,
                    }}
                >
                    no orphaned curves match &quot;{query}&quot;.
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {results.map((o) => (
                        <OrphanCard key={o.curve} orphan={o} />
                    ))}
                </div>
            )}

            <details
                style={{
                    marginTop: 24,
                    fontSize: 11,
                    color: 'var(--anchor-soft)',
                    lineHeight: 1.6,
                }}
            >
                <summary
                    style={{
                        cursor: 'pointer',
                        fontFamily: 'var(--font-round), Klee One, cursive',
                        fontWeight: 700,
                    }}
                >
                    how recovery works + missing token help
                </summary>
                <div style={{ marginTop: 8 }}>
                    connect ur wallet, we read ur token balance from the chain. if u have some,
                    pick how much to sell. u sign approve, then sell, and the curve sends u eth.
                    <br />
                    <br />
                    not seeing ur token? we swept every historical curve factory on robinhood.
                    if urs isn&apos;t listed, either the token graduated or it never launched via our
                    contracts.{' '}
                    <Link href="/trade" style={{ color: 'var(--link-blue)' }}>
                        back to trade
                    </Link>
                    .
                </div>
            </details>
        </div>
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
        abi: bondingCurveAbi,
        address: orphan.curve,
        functionName: 'ethReserve',
        chainId: RH_CHAIN_ID,
    });
    const isGraduated = useReadContract({
        abi: bondingCurveAbi,
        address: orphan.curve,
        functionName: 'graduated',
        chainId: RH_CHAIN_ID,
    });

    // Holder's token balance + current allowance to the curve.
    const balanceQ = useReadContract({
        abi: erc20TokenAbi,
        address: orphan.token,
        functionName: 'balanceOf',
        args: wallet ? [wallet] : undefined,
        chainId: RH_CHAIN_ID,
        query: { enabled: mounted && !!wallet, refetchInterval: 8000 },
    });
    const allowanceQ = useReadContract({
        abi: erc20TokenAbi,
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
            abi: erc20TokenAbi,
            address: orphan.token,
            functionName: 'approve',
            args: [orphan.curve, parsedAmount],
            chainId: RH_CHAIN_ID,
        });
    }

    async function onSell() {
        setLastStep('sell');
        await writeContractAsync({
            abi: bondingCurveAbi,
            address: orphan.curve,
            functionName: 'sell',
            args: [parsedAmount, 0n], // slippage = 0 (curves are low-liquidity, showing a proper quote would need extra reads; MEV isn't a concern at this scale)
            chainId: RH_CHAIN_ID,
        });
    }

    const liveCurveEth = (curveEth.data as bigint | undefined) ?? BigInt(orphan.balanceWeiAtSnapshot);
    const graduated = (isGraduated.data as boolean | undefined) ?? false;

    return (
        <div
            style={{
                border: '2px solid var(--anchor)',
                borderRadius: 8,
                padding: 16,
                background: 'var(--paper-white, #fff)',
                boxShadow: '3px 3px 0 var(--anchor)',
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                <div>
                    <div className="uru-h2" style={{ fontSize: 18 }}>
                        {orphan.tokenName}{' '}
                        <span style={{ fontSize: 12, color: 'var(--anchor-soft)' }}>
                            ({orphan.tokenSymbol})
                        </span>
                    </div>
                    <div
                        style={{
                            fontFamily: 'var(--font-pixel), monospace',
                            fontSize: 10,
                            color: 'var(--anchor-soft)',
                            marginTop: 2,
                            wordBreak: 'break-all',
                        }}
                    >
                        token {orphan.token}
                        <br />
                        curve {orphan.curve}
                    </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, color: 'var(--anchor-soft)' }}>eth in curve</div>
                    <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 16 }}>
                        {Number(formatEther(liveCurveEth)).toFixed(4)}Ξ
                    </div>
                </div>
            </div>

            {graduated ? (
                <div
                    style={{
                        marginTop: 12,
                        padding: 10,
                        background: 'var(--mint)',
                        borderRadius: 6,
                        fontSize: 12,
                        color: 'var(--anchor)',
                    }}
                >
                    ❋ this curve already graduated to a v4 pool. no recovery needed. head to{' '}
                    <Link href={`/trade/${orphan.token}`} style={{ color: 'var(--link-blue)' }}>
                        the trade page
                    </Link>{' '}
                    to swap normally.
                </div>
            ) : liveCurveEth === 0n ? (
                <div style={{ marginTop: 12, padding: 10, background: 'var(--cream)', borderRadius: 6, fontSize: 12 }}>
                    ✓ curve is drained. everyone who wanted their eth back got it.
                </div>
            ) : !effectiveIsConnected ? (
                null
            ) : !onRhChain ? (
                <button
                    onClick={() => switchChain({ chainId: RH_CHAIN_ID })}
                    disabled={switching}
                    style={{
                        marginTop: 12,
                        width: '100%',
                        padding: '10px 12px',
                        background: 'var(--pink-warm)',
                        color: 'var(--anchor)',
                        border: '2px solid var(--anchor)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontFamily: 'var(--font-round), Klee One, cursive',
                        fontSize: 14,
                    }}
                >
                    {switching ? 'switching...' : 'switch to robinhood chain'}
                </button>
            ) : balanceErrored ? (
                <div
                    style={{
                        marginTop: 12,
                        padding: 8,
                        background: 'var(--pink-warm)',
                        borderRadius: 6,
                        fontSize: 12,
                        color: 'var(--anchor)',
                        wordBreak: 'break-word',
                    }}
                >
                    ✗ couldn&apos;t read ur {orphan.tokenSymbol} balance:{' '}
                    <code style={{ fontSize: 11 }}>
                        {(balanceQ.error as Error | null)?.message?.split('\n')[0]?.slice(0, 220) ?? 'unknown'}
                    </code>
                    <div style={{ marginTop: 6, fontSize: 10, opacity: 0.7 }}>
                        token {orphan.token} on robinhood (chain 4663). try a hard refresh, or
                        check the browser console for the full error.
                    </div>
                </div>
            ) : !balanceKnown ? (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--anchor-soft)' }}>
                    checking ur {orphan.tokenSymbol} balance...
                </div>
            ) : holderBalance === 0n ? (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--anchor-soft)' }}>
                    u don&apos;t hold any {orphan.tokenSymbol}. nothing to recover here.
                </div>
            ) : (
                <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 12, color: 'var(--anchor)' }}>
                        ur balance: <b>{Number(formatEther(holderBalance)).toLocaleString()}</b>{' '}
                        {orphan.tokenSymbol}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                        <input
                            value={amountInput}
                            onChange={(e) => setAmountInput(e.target.value)}
                            placeholder="tokens to sell"
                            style={{
                                flex: 1,
                                padding: 8,
                                border: '2px solid var(--anchor)',
                                borderRadius: 6,
                                fontFamily: 'var(--font-pixel), monospace',
                                fontSize: 13,
                            }}
                        />
                        <button
                            onClick={() => setAmountInput(formatEther(holderBalance))}
                            style={{
                                padding: '8px 12px',
                                background: 'var(--cream)',
                                border: '2px solid var(--anchor)',
                                borderRadius: 6,
                                cursor: 'pointer',
                                fontSize: 12,
                                fontFamily: 'var(--font-pixel), monospace',
                            }}
                        >
                            MAX
                        </button>
                    </div>

                    <button
                        onClick={needsApprove ? onApprove : onSell}
                        disabled={!hasEnoughTokens || writing || receipt.isLoading}
                        style={{
                            marginTop: 10,
                            width: '100%',
                            padding: '12px',
                            background: hasEnoughTokens ? 'var(--pink-hot)' : 'var(--anchor-soft)',
                            color: 'white',
                            border: '2px solid var(--anchor)',
                            borderRadius: 6,
                            cursor: hasEnoughTokens ? 'pointer' : 'not-allowed',
                            fontFamily: 'var(--font-round), Klee One, cursive',
                            fontSize: 15,
                            boxShadow: hasEnoughTokens ? '3px 3px 0 var(--anchor)' : undefined,
                        }}
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
                            : `2/2 sell for eth`}
                    </button>

                    {receipt.isSuccess && lastStep === 'sell' && (
                        <div
                            style={{
                                marginTop: 8,
                                padding: 8,
                                background: 'var(--mint)',
                                borderRadius: 6,
                                fontSize: 12,
                            }}
                        >
                            ✓ sold! eth landed in ur wallet. sell more or move on.
                        </div>
                    )}
                    {writeErr && (
                        <div
                            style={{
                                marginTop: 8,
                                padding: 8,
                                background: 'var(--pink-warm)',
                                borderRadius: 6,
                                fontSize: 12,
                                color: 'var(--anchor)',
                            }}
                        >
                            ✗ tx failed: {(writeErr as Error).message?.split('\n')[0]?.slice(0, 200) ?? 'unknown error'}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
