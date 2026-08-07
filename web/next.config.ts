import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Every remote host we serve user-supplied images from. Adding a host
    // here unlocks Vercel's built-in image proxy: automatic WebP/AVIF,
    // per-viewport srcset, 1-year edge cache. Without it, next/image
    // refuses the src at runtime.
    remotePatterns: [
      { protocol: "https", hostname: "gateway.pinata.cloud" },
      // Dedicated Pinata gateway pattern (yourname.mypinata.cloud). Wildcard
      // so a future NEXT_PUBLIC_PINATA_GATEWAY switch requires no config change.
      { protocol: "https", hostname: "**.mypinata.cloud" },
      { protocol: "https", hostname: "ipfs.io" },
      { protocol: "https", hostname: "cloudflare-ipfs.com" },
      // ipfs:// URLs sometimes get normalized to a subdomain gateway.
      { protocol: "https", hostname: "*.ipfs.dweb.link" },
      // X (Twitter) profile image host. Populated on user_profile.x_avatar_url
      // by the /api/auth/x/callback flow after a wallet completes OAuth. The
      // search modal + verified-badge components render these; adding the host
      // here lets next/image serve them via the same optimized pipeline as
      // Pinata avatars instead of falling back to a raw <img>.
      { protocol: "https", hostname: "pbs.twimg.com" },
    ],
    formats: ["image/avif", "image/webp"],
    // Vercel edge cache TTL for the optimized output. Original URL is not
    // touched. 1 year is safe because Pinata CIDs are content-addressed.
    minimumCacheTTL: 31_536_000,
  },
};

export default nextConfig;
