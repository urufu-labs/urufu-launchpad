import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/// Server-side pin proxy — keeps the Pinata JWT off the client bundle. Frontend uploads
/// a base64 data URL, we convert to bytes, forward as FormData to Pinata's pinFileToIPFS,
/// and return the resulting CID + public gateway URL. Bounded 5/min per IP via the
/// registration below so a leaked frontend can't burn our Pinata storage quota.
///
/// Env vars:
///   PINATA_JWT      — server-only. NEVER prefix with NEXT_PUBLIC_.
///   PINATA_GATEWAY  — public gateway host (also served to client via NEXT_PUBLIC_...
///                     — no secret, just for URL construction). Defaults to
///                     gateway.pinata.cloud.

const PINATA_JWT = process.env.PINATA_JWT ?? '';
const PINATA_GATEWAY =
  process.env.PINATA_GATEWAY ?? process.env.NEXT_PUBLIC_PINATA_GATEWAY ?? 'gateway.pinata.cloud';
const PINATA_PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

const MAX_BYTES = 512 * 1024; // 512 KB — matches the client-side upload cap w/ some slack.

const PinFileBody = z.object({
  /// Base64 data URL, e.g. `data:image/png;base64,iVBORw0KGgo...`
  dataUrl: z.string().min(20).max(1_500_000),
  /// Optional caller-set filename for the Pinata pin metadata. Cosmetic.
  filename: z.string().max(100).optional(),
});

function dataUrlToBytes(url: string): { mime: string; bytes: Uint8Array } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mime, b64] = match;
  if (!mime || !b64) return null;
  try {
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    return { mime, bytes };
  } catch {
    return null;
  }
}

function gatewayUrlFor(cid: string): string {
  return `https://${PINATA_GATEWAY.replace(/^https?:\/\//, '')}/ipfs/${cid}`;
}

export async function registerPinRoutes(app: FastifyInstance): Promise<void> {
  // Tighter rate limit than the default 30/min — pinning burns storage quota, not just
  // compute. Uses Fastify's built-in rate limit which was already registered on the app.
  app.post(
    '/pin/file',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      if (!PINATA_JWT) return reply.code(503).send({ code: 'PINATA_NOT_CONFIGURED' });
      const parsed = PinFileBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY', errors: parsed.error.flatten() });

      const decoded = dataUrlToBytes(parsed.data.dataUrl);
      if (!decoded) return reply.code(400).send({ code: 'BAD_DATA_URL' });
      if (decoded.bytes.byteLength > MAX_BYTES) {
        return reply.code(413).send({
          code: 'TOO_LARGE',
          maxBytes: MAX_BYTES,
          got: decoded.bytes.byteLength,
        });
      }

      const fd = new FormData();
      const ext = decoded.mime.split('/')[1] ?? 'bin';
      const name = parsed.data.filename ?? `urufu-${Date.now()}.${ext}`;
      fd.append('file', new Blob([decoded.bytes], { type: decoded.mime }), name);
      fd.append(
        'pinataMetadata',
        JSON.stringify({ name: `urufu-labs-image-${Date.now()}` }),
      );

      try {
        const res = await fetch(PINATA_PIN_FILE_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${PINATA_JWT}` },
          body: fd,
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          app.log.warn({ status: res.status, body: text.slice(0, 200) }, 'pinata pin failed');
          return reply.code(502).send({ code: 'PIN_FAILED', status: res.status });
        }
        const json = (await res.json()) as { IpfsHash?: string };
        const cid = json.IpfsHash;
        if (!cid) return reply.code(502).send({ code: 'PIN_NO_CID' });
        return reply.send({ cid, gatewayUrl: gatewayUrlFor(cid) });
      } catch (err) {
        app.log.warn({ err }, 'pinata pin error');
        return reply.code(502).send({ code: 'PIN_ERROR' });
      }
    },
  );
}
