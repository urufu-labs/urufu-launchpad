import type { MetadataRoute } from 'next';

/// Next.js App-Router robots.txt. General crawlers (Google, Bing, etc.) get
/// the dynamic per-wallet / per-token paths blocked because they carry no
/// SEO value and just eat crawl budget — those live in the "*" rule below.
///
/// Social-preview bots (Twitter/X, Discord, Facebook, LinkedIn, Slack,
/// WhatsApp, Telegram, Pinterest) are listed FIRST as explicit user-agent
/// blocks with `allow: /`. Most robots.txt parsers apply the most-specific
/// user-agent match, so a `Twitterbot` request sees only its own rule and
/// ignores the wildcard. Without this, X's card validator fails with
/// "denied by robots.txt" on every /trade/:addr link and no share card renders.

const SOCIAL_PREVIEW_BOTS = [
  // Twitter / X
  'Twitterbot',
  // Facebook + Instagram
  'facebookexternalhit',
  'facebookcatalog',
  // Discord
  'Discordbot',
  // LinkedIn
  'LinkedInBot',
  // Slack
  'Slackbot',
  'Slackbot-LinkExpanding',
  'Slack-ImgProxy',
  // WhatsApp
  'WhatsApp',
  // Telegram
  'TelegramBot',
  // iMessage / Apple
  'facebookexternalua',
  // Pinterest
  'Pinterestbot',
  // Bluesky
  'Bluesky Cardyb',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Social crawlers — one block PER bot rather than a shared multi-UA
      // group. RFC-compliant parsers (Google) handle shared blocks fine, but
      // Twitter's/X's parser silently ignores the shared Allow when multiple
      // User-Agent lines are stacked and falls through to the wildcard block,
      // producing "denied by robots.txt" on /trade and /profile even with
      // Twitterbot listed. Emitting one { userAgent, allow } per bot gives
      // every parser the same explicit rule.
      ...SOCIAL_PREVIEW_BOTS.map((ua) => ({ userAgent: ua, allow: '/' })),
      // Everyone else — dynamic paths blocked from indexing.
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/profile/', '/trade/'],
      },
    ],
    sitemap: 'https://urufulabs.xyz/sitemap.xml',
  };
}
