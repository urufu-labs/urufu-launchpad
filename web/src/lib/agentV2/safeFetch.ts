/// Server-side image fetch for `upload_image`, hardened against SSRF (threat T12).
///
/// v1's guard matched host NAMES against private patterns, which a DNS name that
/// resolves to 127.0.0.1 / 169.254.169.254, a redirect, or DNS rebinding walks past.
/// Here:
///   - only http(s) on ports 80/443, no credentials in the URL;
///   - IP-literal hosts are checked directly;
///   - named hosts are resolved inside the socket's own `lookup` hook and EVERY
///     address must be public. The socket connects to the address we checked, so
///     there is no second resolution a rebinding DNS server could swap out;
///   - redirects are followed by hand (max 3), each hop re-checked from scratch;
///   - the body is streamed with a hard byte cap and a total timeout;
///   - the bytes must sniff as png / jpeg / gif / webp / avif (no SVG or HTML).

import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

export class FetchGuardError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- IP policy

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inV4(ip: number, cidr: string): boolean {
  const [base, bits] = cidr.split('/') as [string, string];
  const n = Number(bits);
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (ip & mask) === (v4ToInt(base) & mask);
}

const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];

/// Expand an IPv6 string to 8 16-bit groups (handles `::` and a dotted IPv4 tail).
export function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  const v4 = s.slice(lastColon + 1);
  if (v4.includes('.')) {
    if (!net.isIPv4(v4)) return null;
    const n = v4ToInt(v4);
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (parts.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array<string>(parts.length === 2 ? fill : 0).fill('0'), ...rest].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  if (all.length !== 8 || all.some((g) => Number.isNaN(g))) return null;
  return all;
}

/// True only for globally routable unicast addresses.
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return !BLOCKED_V4.some((c) => inV4(n, c));
  }
  if (!net.isIPv6(ip)) return false;
  const g = expandIPv6(ip);
  if (!g) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && (g[7] ?? 0) <= 1) return false; // :: and ::1
    return isPublicIp(`${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`);
  }
  const first = g[0]!;
  if ((first & 0xe000) !== 0x2000) return false; // outside 2000::/3 global unicast
  if (first === 0x2001 && g[1]! < 0x0200) return false; // 2001::/23 IETF (Teredo, ORCHID...)
  if (first === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4 can tunnel to private IPv4
  if (first === 0x0064 && g[1] === 0xff9b) return false; // NAT64 (also outside 2000::/3)
  return true;
}

// ---------------------------------------------------------------- fetch

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface SafeFetchOptions {
  /// DNS resolver; defaults to the OS resolver. Tests inject one.
  resolve?: Resolver;
  /// IP policy; defaults to isPublicIp. Tests can widen it for a loopback fixture.
  allowIp?: (ip: string) => boolean;
  maxBytes?: number;
  /// Port policy; defaults to the standard http(s) ports. Tests use a loopback fixture port.
  allowPort?: (port: string) => boolean;
}

const defaultPort = (p: string) => p === '' || p === '80' || p === '443';

const defaultResolve: Resolver = (hostname) =>
  new Promise((ok, fail) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? fail(err) : ok(addrs)));
  });

/// Parse and pre-check a URL hop. Throws FetchGuardError on anything not allowed.
export function checkUrl(raw: string, allowIp: (ip: string) => boolean = isPublicIp, allowPort: (port: string) => boolean = defaultPort): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchGuardError('imageUrl must be a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchGuardError('imageUrl must be http(s)');
  if (u.username || u.password) throw new FetchGuardError('imageUrl must not contain credentials');
  // A trailing dot is the same DNS name ("localhost." == "localhost").
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) throw new FetchGuardError('imageUrl has no host');
  if (net.isIP(host) && !allowIp(host)) throw new FetchGuardError('imageUrl cannot reference a private, loopback or reserved address');
  if (/(^|\.)(localhost|internal|local|localdomain|home\.arpa)$/i.test(host)) {
    throw new FetchGuardError('imageUrl cannot reference a private, loopback or reserved address');
  }
  if (!allowPort(u.port)) throw new FetchGuardError('imageUrl must use the default http(s) port');
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

function guardedLookup(resolve: Resolver, allowIp: (ip: string) => boolean) {
  return (hostname: string, options: { all?: boolean } | number | undefined, cb: LookupCb) => {
    const all = typeof options === 'object' && options !== null && options.all === true;
    resolve(hostname)
      .then((addrs) => {
        if (addrs.length === 0) throw new FetchGuardError('imageUrl host did not resolve');
        const bad = addrs.find((a) => !allowIp(a.address));
        if (bad) throw new FetchGuardError('imageUrl resolves to a private, loopback or reserved address');
        if (all) cb(null, addrs);
        else cb(null, addrs[0]!.address, addrs[0]!.family);
      })
      .catch((err: Error) => cb(err as NodeJS.ErrnoException, '', 0));
  };
}

interface HopResult {
  status: number;
  location: string | null;
  contentType: string | null;
  body: Buffer | null;
}

function requestOnce(u: URL, opts: Required<Pick<SafeFetchOptions, 'resolve' | 'allowIp' | 'maxBytes'>>, deadline: number): Promise<HopResult> {
  return new Promise((ok, fail) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        lookup: guardedLookup(opts.resolve, opts.allowIp) as unknown as net.LookupFunction,
        headers: { 'user-agent': 'urufu-agent-image-fetch/2', accept: 'image/*' },
        timeout: Math.max(1, deadline - Date.now()),
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          ok({ status, location: res.headers.location ?? null, contentType: null, body: null });
          return;
        }
        const declared = Number(res.headers['content-length'] ?? '0');
        if (declared > opts.maxBytes) {
          res.destroy();
          fail(new FetchGuardError(`image too large (${declared} bytes; max ${opts.maxBytes})`, 413));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            fail(new FetchGuardError(`image too large (over ${opts.maxBytes} bytes)`, 413));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => ok({ status, location: null, contentType: (res.headers['content-type'] ?? null) as string | null, body: Buffer.concat(chunks) }));
        res.on('error', fail);
      },
    );
    req.on('timeout', () => req.destroy(new FetchGuardError('image fetch timed out', 504)));
    req.on('error', (err) => fail(err instanceof FetchGuardError ? err : new FetchGuardError(`image fetch failed: ${err.message}`, 502)));
    req.end();
  });
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/// Identify an image by its first bytes. Returns null for anything else
/// (including SVG, which can carry script).
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif';
  return null;
}

/// Fetch a public image URL and return it as a data URL.
export async function safeFetchImage(url: string, options: SafeFetchOptions = {}): Promise<{ dataUrl: string; bytes: number; mime: string }> {
  const opts = {
    resolve: options.resolve ?? defaultResolve,
    allowIp: options.allowIp ?? isPublicIp,
    maxBytes: options.maxBytes ?? MAX_IMAGE_BYTES,
    allowPort: options.allowPort ?? defaultPort,
  };
  const deadline = Date.now() + TIMEOUT_MS;
  let current = checkUrl(url, opts.allowIp, opts.allowPort);
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(current, opts, deadline);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new FetchGuardError('redirect without a location', 502);
      if (hop >= MAX_REDIRECTS) throw new FetchGuardError('too many redirects', 502);
      current = checkUrl(new URL(res.location, current).toString(), opts.allowIp, opts.allowPort);
      continue;
    }
    if (res.status < 200 || res.status >= 300 || !res.body) throw new FetchGuardError(`image fetch failed with HTTP ${res.status}`, 502);
    const mime = sniffImage(res.body);
    if (!mime) throw new FetchGuardError('imageUrl did not return a png, jpeg, gif, webp or avif image');
    return { dataUrl: `data:${mime};base64,${res.body.toString('base64')}`, bytes: res.body.length, mime };
  }
}

/// Validate an agent-supplied `data:` image URL: allowed type, real image bytes,
/// size cap. Returns the normalized data URL (type taken from the bytes).
export function checkDataUrl(dataUrl: string, maxBytes = MAX_IMAGE_BYTES): { dataUrl: string; bytes: number; mime: string } {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) throw new FetchGuardError('dataUrl must be data:image/<png|jpeg|gif|webp|avif>;base64,...');
  if (!IMAGE_MIME.has(m[1]!.toLowerCase())) throw new FetchGuardError('dataUrl type must be png, jpeg, gif, webp or avif');
  const buf = Buffer.from(m[2]!.replace(/\s/g, ''), 'base64');
  if (buf.length > maxBytes) throw new FetchGuardError(`image too large (${buf.length} bytes; max ${maxBytes})`, 413);
  const mime = sniffImage(buf);
  if (!mime) throw new FetchGuardError('dataUrl bytes are not a png, jpeg, gif, webp or avif image');
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, mime };
}
