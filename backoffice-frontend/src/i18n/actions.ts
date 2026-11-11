'use server';

import { cookies } from 'next/headers';
import { isLocale, localeCookie } from './config';

export async function saveLocalePreference(locale: unknown): Promise<boolean> {
  if (!isLocale(locale)) return false;

  (await cookies()).set(localeCookie, locale, {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });
  return true;
}
