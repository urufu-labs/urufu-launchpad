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
}

interface Props {
  value: MetadataInputs;
  onChange: (next: MetadataInputs) => void;
}

/// Pump.fun-style token metadata form: logo upload, description, socials. Stored locally on
/// launch (localStorage). A proper Pinata + indexer pipeline lands in Phase 5.
export function MetadataForm({ value, onChange }: Props) {
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
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-[11px] text-neutral-500">
        Optional. Stored locally on your device for now — a proper metadata service (IPFS pinning
        + indexer serve) lands in a later phase. Marketplaces will read logo/description/socials
        once that's live.
      </div>

      {/* Logo */}
      <label className="block">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Logo</span>
        <div className="mt-2 flex items-start gap-4">
          <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-md border border-neutral-700 bg-neutral-950">
            {value.logoDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={value.logoDataUrl}
                alt="Token logo preview"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-widest text-neutral-600">
                logo
              </div>
            )}
          </div>
          <div className="flex-1">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(e) => void handleLogo(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-neutral-400 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-neutral-700 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-neutral-200 hover:file:border-neutral-500"
            />
            <div className="mt-1 text-[11px] text-neutral-500">
              PNG / JPEG / WebP / SVG, up to 256 KB. Kept inline as a data URL until IPFS is
              wired up.
            </div>
            {logoError && <div className="mt-1 text-[11px] text-red-400">{logoError}</div>}
          </div>
        </div>
      </label>

      {/* Description */}
      <label className="block">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Description</span>
        <textarea
          value={value.description ?? ''}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          rows={3}
          maxLength={500}
          placeholder="A short pitch. Two or three sentences."
          className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm focus:border-white focus:outline-none"
        />
        <div className="mt-1 text-[11px] text-neutral-500">
          {(value.description ?? '').length}/500
        </div>
      </label>

      {/* Socials */}
      <div className="grid gap-3 sm:grid-cols-2">
        <SocialInput
          label="Website"
          placeholder="https://…"
          value={value.website}
          onChange={(v) => onChange({ ...value, website: v })}
        />
        <SocialInput
          label="Twitter / X"
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
    <label className="block">
      <span className="text-xs uppercase tracking-widest text-neutral-500">{label}</span>
      <input
        type="url"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm font-mono focus:border-white focus:outline-none"
      />
    </label>
  );
}
