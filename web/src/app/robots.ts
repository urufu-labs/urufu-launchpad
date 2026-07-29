import type { MetadataRoute } from 'next';

/// Next.js App-Router robots.txt. Allows all crawlers on everything except the
/// per-user paths that are wallet-scoped noise for search engines (a random
/// wallet's profile page or trade page for a private token has zero SEO value
/// and just eats crawl budget). Points at the sitemap so Google/Bing pick up
/// our canonical page list without guessing.

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // These are dynamic per wallet/token address, so they're not worth
        // crawling as ranked pages. The static home / docs / discover /
        // catalog pages carry all the SEO weight anyway.
        disallow: ['/profile/', '/trade/'],
      },
    ],
    sitemap: 'https://urufulabs.xyz/sitemap.xml',
  };
}
