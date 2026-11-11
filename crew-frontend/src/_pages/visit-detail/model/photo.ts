const maxPhotoBytes = 5 * 1024 * 1024;
export const maxFinishPhotoCount = 100;
export const maxFinishPhotoMiB = 20;
export const photoAccept = 'image/jpeg,image/png,.jpeg,.jpg,.png';
export type PhotoPayload = { name: string; base64: string };

export function photoError(file: File) {
  const extension = /\.(jpe?g|png)$/iu.exec(file.name)?.[1]?.toLowerCase();
  if (!extension || (file.type !== '' && file.type !== (extension === 'png' ? 'image/png' : 'image/jpeg'))) return 'photoType';
  if (file.size === 0 || file.size > maxPhotoBytes) return 'photoSize';
  return null;
}

type FinishPhotoError = NonNullable<ReturnType<typeof photoError>> | 'finishPhotoLimit' | 'finishPhotoTotalSize';

export function selectFinishPhotos(existing: readonly File[], incoming: Iterable<File>) {
  const added: File[] = [];
  let bytes = existing.reduce((total, file) => total + file.size, 0);
  let error: FinishPhotoError | null = null;

  for (const file of incoming) {
    if (existing.length + added.length >= maxFinishPhotoCount) {
      error ??= 'finishPhotoLimit';
      break;
    }
    const failure = photoError(file);
    if (failure) {
      error ??= failure;
      continue;
    }
    if (bytes + file.size > maxFinishPhotoMiB * 1024 * 1024) {
      error ??= 'finishPhotoTotalSize';
      continue;
    }
    added.push(file);
    bytes += file.size;
  }

  return { added, error };
}

function photoName(file: File) {
  if (file.name.length <= 120 && /^[\p{L}\p{N} _().-]+$/u.test(file.name) && !file.name.startsWith('.') && !file.name.includes('..')) return file.name;
  return file.name.toLowerCase().endsWith('.png') ? 'visit-photo.png' : 'visit-photo.jpg';
}

export function encodePhoto(file: File): Promise<PhotoPayload | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const value = reader.result;
      const comma = typeof value === 'string' ? value.indexOf(',') : -1;
      resolve(typeof value === 'string' && comma >= 0
        ? { name: photoName(file), base64: value.slice(comma + 1) }
        : null);
    }, { once: true });
    reader.addEventListener('error', () => resolve(null), { once: true });
    reader.addEventListener('abort', () => resolve(null), { once: true });
    reader.readAsDataURL(file);
  });
}
