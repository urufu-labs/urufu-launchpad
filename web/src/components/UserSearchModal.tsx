'use client';

/// Header-anchored user directory search. Renders a compact button that
/// mounts a full modal on click; the modal debounces typing (300ms), aborts
/// stale requests as new keystrokes arrive, and navigates to the clicked
/// profile page. Also wires a `/` global shortcut like GitHub / Vercel so
/// keyboard users can jump into the search without touching the mouse.
///
/// Backend contract: GET /profile/search?q=<term>&limit=20 — see
/// compile-service/src/routes/social.ts. Rate-limited server-side (10/min
/// per IP by default); the modal shows a distinct toast on 429 so the
/// user knows to slow down instead of assuming their search "broke".
///
/// Aesthetic: same kawaiicore shell language as FollowersModal /
/// WelcomeModal — cream `uru-shell` card, dark border, offset shadow, esc /
/// backdrop / X close.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

import { searchProfiles, type RemoteProfileSearchHit } from '@/lib/socialApi';

// -------------------------- constants

/// Time the input waits after the last keystroke before firing a search.
/// 300ms is the same feel as GitHub / Notion / Vercel — fast enough that
/// typing "vita" feels live, slow enough that we don't fire four requests
/// while the user is mid-word.
const DEBOUNCE_MS = 300;
/// Client-side sanity match with the server. Anything shorter than 2 chars
/// will get an empty response anyway (enumeration guard), so short-circuit
/// here to avoid a network round-trip.
const MIN_SEARCH_LEN = 2;

// -------------------------- types

/// Toast state — the modal renders a small strip along the top of the
/// results list. Uses discriminated union so the copy is always derived
/// from a single source of truth.
type Toast =
  | { kind: 'rate-limited' }
  | { kind: 'error' }
  | null;

// -------------------------- root

/// Button + modal pair. The button lives in the header; the modal renders
/// as a full-viewport overlay when open. We keep both in one component so
/// the `/` shortcut only has to reach one piece of state, not thread a
/// prop through the entire header.
export function UserSearchLauncher(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const openModal = useCallback(() => setOpen(true), []);
  const closeModal = useCallback(() => setOpen(false), []);

  // ---- global `/` shortcut. Match on the RAW event target rather than
  // `document.activeElement` to catch the case where a focused button
  // still receives the key (activeElement === input would skip; a plain
  // button target would trigger).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      // Skip if the user is typing into any editable element already —
      // otherwise `/` in a chat input, search field, or contenteditable
      // would open the modal instead of inserting the character.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      // Also skip if the modal is already open — the input inside the
      // modal handles `/` as a normal keystroke.
      if (open) return;
      e.preventDefault();
      openModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, openModal]);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        aria-label="search users"
        title="search people ( press / )"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          background: 'var(--cream)',
          color: 'var(--anchor)',
          border: '1.5px solid var(--anchor)',
          boxShadow: '2px 2px 0 var(--anchor)',
          borderRadius: 999,
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 11,
          letterSpacing: '0.02em',
          cursor: 'pointer',
          lineHeight: 1,
        }}
      >
        <span aria-hidden>⌒</span>
        <span>search</span>
        {/* Compact kbd hint — hidden on very small viewports since screen space
            is precious next to the wallet + chain switcher. */}
        <kbd
          className="hidden md:inline"
          style={{
            marginLeft: 4,
            padding: '0 4px',
            border: '1px solid var(--anchor-soft, var(--anchor))',
            borderRadius: 4,
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 9,
            opacity: 0.7,
          }}
        >
          /
        </kbd>
      </button>
      {open ? <UserSearchModal onClose={closeModal} /> : null}
    </>
  );
}

// -------------------------- modal

function UserSearchModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<RemoteProfileSearchHit[] | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  // ---- ESC + focus. Autofocus the input on mount so the user can start
  // typing without a second click after the button opens the modal.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ---- debounce keystrokes into `debouncedQ`. Every character resets the
  // timer; the timer's fire is the ONLY thing that ever calls the search
  // function, so a fast typist can burn through 10 characters and still
  // only pay for one HTTP request at the end.
  useEffect(() => {
    const trimmed = q.trim();
    const t = setTimeout(() => setDebouncedQ(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // ---- fire the search whenever the debounced query changes. AbortController
  // wired to the outgoing fetch so a still-in-flight request from a stale
  // query never wins the race back into `results` (which would make the
  // list flicker to old data on fast typing).
  useEffect(() => {
    if (debouncedQ.length < MIN_SEARCH_LEN) {
      setResults(null);
      setLoading(false);
      setToast(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setToast(null);
    (async () => {
      const out = await searchProfiles(debouncedQ, { signal: controller.signal });
      // Cancelled requests are meaningless — a newer keystroke is already
      // in flight. Bail without touching state so the next resolution wins.
      if (out.ok === false && out.error === 'aborted') return;
      if (out.ok) {
        setResults(out.results);
        setToast(null);
      } else if (out.error === 'rate-limited') {
        setToast({ kind: 'rate-limited' });
        // Keep the previous results visible so a rate-limited retry doesn't
        // wipe a good response off the screen mid-panic.
      } else {
        setToast({ kind: 'error' });
      }
      setLoading(false);
    })();
    return () => controller.abort();
  }, [debouncedQ]);

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="find people"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(58, 44, 58, 0.45)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        zIndex: 100,
        padding: '10vh 16px 16px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="uru-shell"
        style={{
          background: 'var(--cream)',
          width: '100%',
          maxWidth: 480,
          maxHeight: '75vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
        }}
      >
        {/* header strip: title + close */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '10px 14px',
            borderBottom: '1.5px solid var(--anchor)',
            background: 'var(--cream-deep)',
          }}
        >
          <div className="uru-eyebrow" id="user-search-title">⌒ find people</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            style={{
              fontFamily: 'var(--font-round), Klee One, cursive',
              fontSize: 14,
              padding: '2px 10px',
              borderRadius: 999,
              border: '1.5px solid var(--anchor)',
              background: 'var(--cream)',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* input strip */}
        <div style={{ padding: '10px 14px', borderBottom: '1px dashed var(--cream-shadow)' }}>
          <input
            ref={inputRef}
            type="search"
            className="uru-input"
            placeholder="address, name, or @handle"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-labelledby="user-search-title"
          />
          {/* Toast row — surfaces rate-limit + error states without wiping
              the results list. Kept lightweight so it doesn't compete with
              the input visually. */}
          {toast ? (
            <div
              role="status"
              style={{
                marginTop: 8,
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 11,
                color: toast.kind === 'rate-limited' ? 'var(--pink-hot)' : 'var(--anchor-soft)',
              }}
            >
              {toast.kind === 'rate-limited'
                ? 'too fast ~ try again in a sec'
                : 'search hiccup ~ try again'}
            </div>
          ) : null}
        </div>

        {/* results body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          <ResultsList
            q={debouncedQ}
            loading={loading}
            results={results}
            onPick={onClose}
          />
        </div>
      </div>
    </div>
  );
}

// -------------------------- results list

function ResultsList({
  q,
  loading,
  results,
  onPick,
}: {
  q: string;
  loading: boolean;
  results: RemoteProfileSearchHit[] | null;
  onPick: () => void;
}): React.ReactElement {
  const emptyStyle: React.CSSProperties = {
    padding: 24,
    textAlign: 'center',
    color: 'var(--anchor-soft)',
    fontSize: 12,
    fontFamily: 'var(--font-pixel), monospace',
  };

  // Below-min: prompt copy. Server + client both short-circuit sub-2-char
  // queries, so the modal never renders "loading" for those.
  if (q.length < MIN_SEARCH_LEN) {
    return <div style={emptyStyle}>type an address, name, or @handle</div>;
  }
  if (loading && results === null) {
    return (
      <div style={emptyStyle} aria-live="polite">
        looking..
      </div>
    );
  }
  if (results !== null && results.length === 0) {
    return <div style={emptyStyle}>no one matches ~</div>;
  }
  if (results === null) {
    // shouldn't happen — but if it does, render the same "type" state so
    // the modal never sits blank.
    return <div style={emptyStyle}>type an address, name, or @handle</div>;
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {results.map((hit) => (
        <SearchResultRow key={hit.address} hit={hit} onPick={onPick} />
      ))}
    </ul>
  );
}

// -------------------------- single row

function SearchResultRow({
  hit,
  onPick,
}: {
  hit: RemoteProfileSearchHit;
  onPick: () => void;
}): React.ReactElement {
  // Prefer the user's Pinata upload over the twitter avatar; fall back to
  // twimg if no Pinata avatar; fall back to the first letter of the
  // display label if neither host has an image. next/image handles both
  // Pinata + pbs.twimg.com via remotePatterns.
  const avatar = hit.avatarUrl ?? hit.xAvatarUrl ?? null;
  const short = `${hit.address.slice(0, 6)}…${hit.address.slice(-4)}`;
  const label = hit.username?.trim() || short;

  return (
    <li>
      <Link
        href={`/profile/${hit.address}`}
        onClick={onPick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          borderBottom: '1px dashed var(--cream-shadow)',
          textDecoration: 'none',
          color: 'var(--anchor)',
        }}
      >
        {/* avatar */}
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'var(--pink-warm)',
            border: '1.5px solid var(--anchor)',
            overflow: 'hidden',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-round), Klee One, cursive',
            fontSize: 13,
            fontWeight: 700,
            position: 'relative',
          }}
        >
          {avatar ? (
            <Image
              src={avatar}
              alt=""
              width={32}
              height={32}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            label.slice(0, 1).toUpperCase()
          )}
        </div>

        {/* name + handle + short-address */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
              fontFamily: 'var(--font-round), Klee One, cursive',
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.2,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {label}
            </span>
            {hit.xVerifiedHandle ? (
              <VerifiedHandlePill handle={hit.xVerifiedHandle} />
            ) : hit.twitter ? (
              <UnverifiedHandlePill value={hit.twitter} />
            ) : null}
          </div>
          <div
            className="uru-num"
            style={{
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 10,
              color: 'var(--anchor-soft)',
              lineHeight: 1.3,
              marginTop: 2,
            }}
          >
            {short}
          </div>
        </div>
      </Link>
    </li>
  );
}

// -------------------------- handle badges

/// Mint pill with a ✓ — same visual language as the profile page's
/// XVerifiedBadge but non-anchor (the whole row is a Link already; nesting
/// an <a> inside another Link would break router navigation and hydration).
function VerifiedHandlePill({ handle }: { handle: string }): React.ReactElement {
  return (
    <span
      title="verified X account"
      style={{
        padding: '1px 6px',
        fontSize: 10,
        fontFamily: 'var(--font-pixel), monospace',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        background: 'var(--mint)',
        color: 'var(--mint-hot,#2b8a3e)',
        border: '1px solid var(--anchor)',
        borderRadius: 4,
      }}
    >
      @{handle} <span aria-hidden>✓</span>
      <span className="sr-only">verified</span>
    </span>
  );
}

/// Grayed pill with an (unverified) suffix. Never a link — the wallet
/// hasn't proved ownership of this handle so we deliberately don't send
/// the visitor to x.com/<handle>, which would legitimize the claim.
function UnverifiedHandlePill({ value }: { value: string }): React.ReactElement {
  // Strip leading @ / url prefix for display; matches profile page copy.
  const display = value
    .replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .split(/[/?#]/)[0];
  return (
    <span
      title="self-declared handle, not verified"
      style={{
        padding: '1px 6px',
        fontSize: 10,
        fontFamily: 'var(--font-pixel), monospace',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        border: '1px dashed var(--anchor-soft)',
        color: 'var(--anchor-soft)',
        borderRadius: 4,
      }}
    >
      @{display || value} (unverified)
    </span>
  );
}
