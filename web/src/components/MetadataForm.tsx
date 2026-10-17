'use client';

import { useState } from 'react';

import { readFileAsDataUrl } from '@/lib/metadata';
import styles from './MetadataForm.module.css';

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

/// Pump.fun-style token metadata form: logo upload, description, socials. Uses the
/// site's role tokens so it slots into the shop, launch flow, and the
/// per-token edit modal without palette clashes.
export function MetadataForm({ value, onChange, hideIntro = false }: Props) {
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoNotice, setLogoNotice] = useState<string | null>(null);

  async function handleLogo(file: File | null) {
    setLogoError(null);
    setLogoNotice(null);
    if (!file) {
      onChange({ ...value, logoDataUrl: undefined });
      return;
    }
    try {
      const result = await readFileAsDataUrl(file);
      onChange({ ...value, logoDataUrl: result.dataUrl });
      if (result.optimized) {
        setLogoNotice(
          `Optimized ${Math.ceil(result.originalBytes / 1024)}KB → ${Math.ceil(result.outputBytes / 1024)}KB for launch.`,
        );
      }
    } catch (err) {
      setLogoError((err as Error).message);
    }
  }

  return (
    <div className={styles.form}>
      {!hideIntro && (
        <div className={styles.intro}>
          Add an image and a short description so your token looks right on Discover, the
          home page and every trade page. Everyone sees the same thing once you sign the save.
        </div>
      )}

      {/* Logo */}
      <label className="ui-field">
        <span className="ui-field-label">Logo</span>
        <div className={styles.logoRow}>
          <div className={styles.logoBox} data-filled={value.logoDataUrl ? 'true' : undefined}>
            {value.logoDataUrl ? (
              // Local data URL preview (before Pinata pin) — raw img by design;
              // next/image proxy only handles http(s) sources. width/height +
              // decoding hint prevents layout shift while the file decodes.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={value.logoDataUrl}
                alt="Token logo preview"
                width={64}
                height={64}
                decoding="async"
              />
            ) : (
              <span>Logo</span>
            )}
          </div>
          <div className={styles.logoMeta}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml,image/avif"
              onChange={(e) => void handleLogo(e.target.files?.[0] ?? null)}
              className={styles.file}
            />
            <span className="ui-hint">
              PNG, JPEG, WebP or SVG up to 10MB. Larger images are resized for launch.
            </span>
            {logoNotice && <span className="ui-hint">{logoNotice}</span>}
            {logoError && <span className="ui-error">{logoError}</span>}
          </div>
        </div>
      </label>

      {/* Description */}
      <label className="ui-field">
        <span className="ui-field-label">Description</span>
        <textarea
          className="ui-input"
          value={value.description ?? ''}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          rows={3}
          maxLength={500}
          placeholder="A short pitch, two or three sentences."
        />
        <span className={`ui-hint ${styles.count}`}>
          {(value.description ?? '').length}/500
        </span>
      </label>

      {/* Socials */}
      <div className={styles.socials}>
        <SocialInput
          label="Website"
          placeholder="https://…"
          value={value.website}
          onChange={(v) => onChange({ ...value, website: v })}
        />
        <SocialInput
          label="X (Twitter)"
          placeholder="https://x.com/…"
          value={value.twitter}
          onChange={(v) => onChange({ ...value, twitter: v })}
        />
        <SocialInput
          label="Telegram"
          placeholder="https://t.me/…"
          value={value.telegram}
          onChange={(v) => onChange({ ...value, telegram: v })}
        />
        <SocialInput
          label="Discord"
          placeholder="https://discord.gg/…"
          value={value.discord}
          onChange={(v) => onChange({ ...value, discord: v })}
        />
        <SocialInput
          label="TikTok"
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
    <label className="ui-field">
      <span className="ui-field-label">{label}</span>
      <input
        className="ui-input"
        type="url"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
