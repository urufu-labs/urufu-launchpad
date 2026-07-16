'use client';

import { useState } from 'react';

import { readFileAsDataUrl } from '@/lib/metadata';

export interface MetadataInputs {
  logoDataUrl?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  tiktok?: string;
}

interface Props {
  value: MetadataInputs;
  onChange: (next: MetadataInputs) => void;
  /// When true, hides the intro banner (used inside the trade-page edit modal where
  /// the modal title already carries the context).
  hideIntro?: boolean;
}

const EYEBROW: React.CSSProperties = {
  fontFamily: 'var(--font-pixel), monospace',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--anchor-soft)',
};

/// Pump.fun-style token metadata form: logo upload, description, socials. Uses the
/// site's cream/paper design tokens so it slots into the shop, launch flow, and the
/// per-token edit modal without palette clashes.
export function MetadataForm({ value, onChange, hideIntro = false }: Props) {
  const [logoError, setLogoError] = useState<string | null>(null);

  async function handleLogo(file: File | null) {
    setLogoError(null);
    if (!file) {
      onChange({ ...value, logoDataUrl: undefined });
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      onChange({ ...value, logoDataUrl: dataUrl });
    } catch (err) {
      setLogoError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      {!hideIntro && (
        <div
          style={{
            padding: 10,
            border: '1.5px dashed var(--anchor)',
            background: 'var(--mint)',
            fontFamily: 'var(--font-round), Klee One, cursive',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--anchor)',
          }}
        >
          ✿ pin an image + a lil description so ur token shows up right on discover, home,
          and every trade page. everyone sees the same thing once u sign the save ~
        </div>
      )}

      {/* Logo */}
      <label style={{ display: 'block' }}>
        <span style={EYEBROW}>logo</span>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div
            style={{
              width: 64,
              height: 64,
              flexShrink: 0,
              border: '1.5px solid var(--anchor)',
              boxShadow: '2px 2px 0 var(--anchor)',
              overflow: 'hidden',
              background: value.logoDataUrl ? '#fff' : 'var(--cream-deep)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {value.logoDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={value.logoDataUrl}
                alt="Token logo preview"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <span style={{ ...EYEBROW, fontSize: 9 }}>logo</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(e) => void handleLogo(e.target.files?.[0] ?? null)}
              style={{
                display: 'block',
                width: '100%',
                fontFamily: 'var(--font-round), Klee One, cursive',
                fontSize: 12,
                color: 'var(--anchor)',
              }}
            />
            <div
              style={{
                marginTop: 6,
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 10,
                color: 'var(--anchor-soft)',
                lineHeight: 1.5,
              }}
            >
              png / jpeg / webp / svg, up to 256 kb. gets pinned to ipfs on save ~
            </div>
            {logoError && (
              <div
                style={{
                  marginTop: 6,
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 10,
                  color: 'var(--pink-hot)',
                }}
              >
                {logoError}
              </div>
            )}
          </div>
        </div>
      </label>

      {/* Description */}
      <label style={{ display: 'block' }}>
        <span style={EYEBROW}>description</span>
        <textarea
          className="uru-input"
          value={value.description ?? ''}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          rows={3}
          maxLength={500}
          placeholder="a short pitch. two or three sentences ~"
          style={{ marginTop: 6, width: '100%', resize: 'vertical', minHeight: 64, fontFamily: 'var(--font-round), Klee One, cursive' }}
        />
        <div
          style={{
            marginTop: 4,
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 10,
            color: 'var(--anchor-soft)',
          }}
        >
          {(value.description ?? '').length}/500
        </div>
      </label>

      {/* Socials */}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <SocialInput
          label="website"
          placeholder="https://…"
          value={value.website}
          onChange={(v) => onChange({ ...value, website: v })}
        />
        <SocialInput
          label="twitter / x"
          placeholder="https://x.com/…"
          value={value.twitter}
          onChange={(v) => onChange({ ...value, twitter: v })}
        />
        <SocialInput
          label="telegram"
          placeholder="https://t.me/…"
          value={value.telegram}
          onChange={(v) => onChange({ ...value, telegram: v })}
        />
        <SocialInput
          label="discord"
          placeholder="https://discord.gg/…"
          value={value.discord}
          onChange={(v) => onChange({ ...value, discord: v })}
        />
        <SocialInput
          label="tiktok"
          placeholder="https://tiktok.com/@…"
          value={value.tiktok}
          onChange={(v) => onChange({ ...value, tiktok: v })}
        />
      </div>
    </div>
  );
}

function SocialInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: 'block' }}>
      <span style={EYEBROW}>{label}</span>
      <input
        className="uru-input"
        type="url"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ marginTop: 6, width: '100%', fontFamily: 'var(--font-round), Klee One, cursive' }}
      />
    </label>
  );
}
