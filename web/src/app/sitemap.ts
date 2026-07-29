import type { MetadataRoute } from 'next';

/// Static sitemap covering our canonical top-level pages. Dynamic pages
/// (/profile/:address, /trade/:address) are deliberately excluded — they'd
/// balloon the sitemap and offer no SEO value since each is per-wallet /
/// per-token content that isn't a ranked destination.
///
/// Update the `lastModified` when a page's content materially changes —
/// crawlers use it to schedule re-visits.

const BASE = 'https://urufulabs.xyz';

export default function sitemap(): MetadataRoute.Sitemap {
  // Static timestamp — Date.now() is banned in Next.js server pages by the
  // React-purity rules and would break at build time. Bump manually when
  // launching new top-level pages or a major site redesign.
  const lastModified = '2026-07-29';

  return [
    { url: `${BASE}/`, lastModified, changeFrequency: 'daily', priority: 1.0 },
    { url: `${BASE}/discover`, lastModified, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${BASE}/catalog`, lastModified, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE}/create`, lastModified, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${BASE}/docs`, lastModified, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${BASE}/feed`, lastModified, changeFrequency: 'daily', priority: 0.5 },
  ];
}
