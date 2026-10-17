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
/// Aesthetic: global ui-overlay / ui-dialog look (same as FollowersModal),
/// esc / backdrop / X close.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import Image from 'next/image';

import { searchProfiles, type RemoteProfileSearchHit } from '@/lib/socialApi';
import { IconSearch } from '@/components/shell/icons';
import shellStyles from '@/components/shell/shell.module.css';
import m from './UserSearchModal.module.css';

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
        aria-label="Search people"
        title="Search people (press /)"
        className={shellStyles.searchBtn}
      >
        <IconSearch />
        <span>Search people</span>
        <kbd>/</kbd>
      </button>
      {open ? createPortal(<UserSearchModal onClose={closeModal} />, document.body) : null}
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
      className={`ui-overlay ${m.overlay}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`ui-dialog ${m.dialog}`}
      >
        {/* header strip: title + close */}
        <div className={`ui-dialog-head ${m.head}`}>
          <h2 className="ui-dialog-title" id="user-search-title">Find people</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className={`ui-icon-btn ${m.close}`}
            data-size="sm"
          >
            ×
          </button>
        </div>

        {/* input strip */}
        <div className={m.searchRow}>
          <input
            ref={inputRef}
            type="search"
            className="ui-input"
            placeholder="Address, name or @handle"
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
            <div role="status" className={m.toast} data-kind={toast.kind}>
              {toast.kind === 'rate-limited'
                ? 'Too many searches. Try again in a moment.'
                : 'Search failed. Please try again.'}
            </div>
          ) : null}
        </div>

        {/* results body */}
        <div className={m.body}>
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
  // Below-min: prompt copy. Server + client both short-circuit sub-2-char
  // queries, so the modal never renders "loading" for those.
  if (q.length < MIN_SEARCH_LEN) {
    return <div className={m.empty}>Type an address, name or @handle.</div>;
  }
  if (loading && results === null) {
    return (
      <div className={m.empty} aria-live="polite">
        Searching…
      </div>
    );
  }
  if (results !== null && results.length === 0) {
    return <div className={m.empty}>No one matches that search.</div>;
  }
  if (results === null) {
    // shouldn't happen — but if it does, render the same "type" state so
    // the modal never sits blank.
    return <div className={m.empty}>Type an address, name or @handle.</div>;
  }
  return (
    <ul className={m.list}>
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
        className={m.row}
      >
        {/* avatar */}
        <div className={m.avatar}>
          {avatar ? (
            <Image
              src={avatar}
              alt=""
              width={36}
              height={36}
            />
          ) : (
            label.slice(0, 1).toUpperCase()
          )}
        </div>

        {/* name + handle + short-address */}
        <div className={m.text}>
          <div className={m.nameRow}>
            <span className={m.name}>
              {label}
            </span>
            {hit.xVerifiedHandle ? (
              <VerifiedHandlePill handle={hit.xVerifiedHandle} />
            ) : hit.twitter ? (
              <UnverifiedHandlePill value={hit.twitter} />
            ) : null}
          </div>
          <div className={m.address}>
            {short}
          </div>
        </div>
      </Link>
    </li>
  );
}

// -------------------------- handle badges

/// Badge with a ✓ — same visual language as the profile page's
/// XVerifiedBadge but non-anchor (the whole row is a Link already; nesting
/// an <a> inside another Link would break router navigation and hydration).
function VerifiedHandlePill({ handle }: { handle: string }): React.ReactElement {
  return (
    <span
      title="Verified X account"
      className="ui-badge"
      data-tone="info"
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
      title="Self-declared handle, not verified"
      className="ui-badge"
    >
      @{display || value} (unverified)
    </span>
  );
}
