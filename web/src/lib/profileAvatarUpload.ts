import { upload } from '@vercel/blob/client';
import type { Address } from 'viem';

import type { SignFn } from './socialApi';
import {
  PROFILE_AVATAR_CONTENT_TYPES,
  PROFILE_AVATAR_MAX_BYTES,
  profileAvatarExtension,
  profileAvatarUploadMessage,
} from './profileAvatarAuth';

export function assertProfileAvatarFile(file: File): void {
  if (!PROFILE_AVATAR_CONTENT_TYPES.includes(file.type as typeof PROFILE_AVATAR_CONTENT_TYPES[number])) {
    throw new Error('avatar must be a PNG, JPG, WebP, GIF, or AVIF image');
  }
  if (file.size > PROFILE_AVATAR_MAX_BYTES) {
    throw new Error('avatar is too large — choose an image under 10MB');
  }
}

export async function isProfileAvatarBlobConfigured(): Promise<boolean> {
  try {
    const res = await fetch('/api/profile-avatar', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json()) as { configured?: boolean };
    return body.configured === true;
  } catch {
    return false;
  }
}

export async function uploadProfileAvatar(file: File, address: Address | string, sign: SignFn): Promise<string> {
  assertProfileAvatarFile(file);
  const owner = address.toLowerCase();
  const timestamp = Date.now();
  const signature = await sign({ message: profileAvatarUploadMessage(owner, timestamp) });
  const blob = await upload(`profile-avatars/${owner}/avatar.${profileAvatarExtension(file.type)}`, file, {
    access: 'public',
    contentType: file.type,
    handleUploadUrl: '/api/profile-avatar',
    clientPayload: JSON.stringify({ address: owner, timestamp, signature }),
    // The UI caps at 10MB, but multipart keeps a disrupted connection from
    // restarting a larger avatar from zero.
    multipart: file.size > 4 * 1024 * 1024,
  });
  return blob.url;
}
