'use server';

import { cookies } from 'next/headers';
import { isLocale, localeCookie } from './config';

export async function saveCrewLocale(locale: unknown) {
  if (!isLocale(locale)) return;

  (await cookies()).set(localeCookie, locale, {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60,
  });
}
