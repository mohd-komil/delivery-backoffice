import { cookies } from 'next/headers';
import { localeCookie, resolveLocale } from './config';

export async function getCrewLocale() {
  return resolveLocale((await cookies()).get(localeCookie)?.value);
}
