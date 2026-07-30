'use client';

import Link from 'next/link';

import { Mascot } from '@/components/Mascot';

/// Temporary splash for the pre-launch window. Rendered by app/page.tsx
/// when LAUNCHPAD_LIVE is false. Delete both the file and the branch in
/// page.tsx to remove after launch (single revert commit).
///
/// Copy voice per user's memory rules:
///   - no em dashes (use commas / periods)
///   - keep it simple, plain language, not engineering vocab
///   - warm, a little playful, doesn't overpromise
export function NotLiveYet() {
    return (
        <main
            style={{
                minHeight: 'calc(100vh - 60px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '32px 20px',
            }}
        >
            <section
                className="uru-shell"
                style={{
                    maxWidth: 620,
                    width: '100%',
                    background: 'var(--cream)',
                    textAlign: 'center',
                    padding: '40px 28px',
                    position: 'relative',
                }}
            >
                {/* JP accent tag, top-right — matches the 報酬 / 卒業 pattern used elsewhere */}
                <span
                    style={{
                        position: 'absolute',
                        top: 14,
                        right: 18,
                        fontFamily: 'var(--font-jp), monospace',
                        fontSize: 11,
                        color: 'var(--anchor-soft)',
                        letterSpacing: '0.05em',
                    }}
                >
                    準備中
                </span>

                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
                    <Mascot size={112} mood="sleepy" />
                </div>

                <h1
                    style={{
                        fontFamily: 'var(--font-display), serif',
                        fontSize: 'clamp(32px, 7vw, 56px)',
                        lineHeight: 1.05,
                        color: 'var(--pink-hot)',
                        margin: '0 0 12px',
                        letterSpacing: '-0.01em',
                    }}
                >
                    not live yet
                </h1>

                <p
                    style={{
                        fontFamily: 'var(--font-round), serif',
                        fontSize: 'clamp(15px, 3vw, 18px)',
                        color: 'var(--anchor-soft)',
                        lineHeight: 1.55,
                        margin: '0 auto 22px',
                        maxWidth: 480,
                    }}
                >
                    we&apos;re finishing a few last things before we open. please don&apos;t launch anything right now,
                    it might not work the way we want it to.
                </p>

                <div
                    style={{
                        display: 'inline-block',
                        padding: '8px 14px',
                        borderRadius: 999,
                        background: 'var(--yolk)',
                        border: '1.5px solid var(--anchor)',
                        boxShadow: '0 2px 0 var(--anchor)',
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 12,
                        color: 'var(--anchor)',
                        letterSpacing: '0.04em',
                        transform: 'rotate(-1.5deg)',
                    }}
                >
                    urufu is taking a nap. brb.
                </div>

                <div
                    style={{
                        marginTop: 28,
                        paddingTop: 18,
                        borderTop: '1px dashed var(--cream-shadow)',
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 12,
                        color: 'var(--anchor-soft)',
                        lineHeight: 1.7,
                    }}
                >
                    <div style={{ marginBottom: 4 }}>while you wait ~~</div>
                    <Link
                        href="https://x.com/spoobsV1"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            color: 'var(--link-blue)',
                            textDecoration: 'underline',
                            textUnderlineOffset: 2,
                        }}
                    >
                        follow along on x
                    </Link>
                    <span style={{ margin: '0 8px', color: 'var(--anchor-soft)' }}>·</span>
                    <Link
                        href="/docs"
                        style={{
                            color: 'var(--link-blue)',
                            textDecoration: 'underline',
                            textUnderlineOffset: 2,
                        }}
                    >
                        read what we&apos;re building
                    </Link>
                </div>
            </section>
        </main>
    );
}
