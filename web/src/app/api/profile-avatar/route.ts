import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { isAddress, verifyMessage } from 'viem';

import {
  PROFILE_AVATAR_CONTENT_TYPES,
  PROFILE_AVATAR_MAX_BYTES,
  profileAvatarUploadMessage,
} from '@/lib/profileAvatarAuth';

export const dynamic = 'force-dynamic';

interface UploadAuthorization {
  address: string;
  timestamp: number;
  signature: `0x${string}`;
}

export async function GET(): Promise<Response> {
  return Response.json({ configured: Boolean(process.env.BLOB_READ_WRITE_TOKEN) });
}

export async function POST(request: Request): Promise<Response> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json({ code: 'BLOB_NOT_CONFIGURED' }, { status: 503 });
  }

  try {
    const body = await request.json() as HandleUploadBody;
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const authorization = parseAuthorization(clientPayload);
        const owner = authorization.address.toLowerCase();
        if (!pathname.startsWith(`profile-avatars/${owner}/`)) {
          throw new Error('avatar upload path does not match the signing wallet');
        }
        const valid = await verifyMessage({
          address: owner as `0x${string}`,
          message: profileAvatarUploadMessage(owner, authorization.timestamp),
          signature: authorization.signature,
        });
        if (!valid) throw new Error('avatar upload signature is invalid');

        return {
          allowedContentTypes: [...PROFILE_AVATAR_CONTENT_TYPES],
          maximumSizeInBytes: PROFILE_AVATAR_MAX_BYTES,
          validUntil: Date.now() + 60_000,
          addRandomSuffix: true,
          cacheControlMaxAge: 60 * 60 * 24 * 30,
        };
      },
    });
    return Response.json(response);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'invalid avatar upload' },
      { status: 400 },
    );
  }
}

function parseAuthorization(value: string | null): UploadAuthorization {
  if (!value) throw new Error('missing avatar upload authorization');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('invalid avatar upload authorization');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid avatar upload authorization');
  const candidate = parsed as Partial<UploadAuthorization>;
  const age = Math.abs(Date.now() - Number(candidate.timestamp));
  if (typeof candidate.address !== 'string' || !isAddress(candidate.address) || typeof candidate.signature !== 'string' || !Number.isFinite(age) || age > 5 * 60 * 1000) {
    throw new Error('avatar upload authorization expired or malformed');
  }
  return {
    address: candidate.address,
    timestamp: Number(candidate.timestamp),
    signature: candidate.signature as `0x${string}`,
  };
}
