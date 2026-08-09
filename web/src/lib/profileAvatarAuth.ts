export const PROFILE_AVATAR_MAX_BYTES = 10 * 1024 * 1024;

export const PROFILE_AVATAR_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

export function profileAvatarUploadMessage(address: string, timestamp: number): string {
  return `urufu:profile-avatar-upload:${address.toLowerCase()}:${timestamp}`;
}

export function profileAvatarExtension(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'image/avif': return 'avif';
    default: return 'img';
  }
}
