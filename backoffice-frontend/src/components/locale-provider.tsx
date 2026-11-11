'use client';

import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import type { Locale } from '@/i18n/config';
import type { messagesForLocale } from '@/i18n/messages';
import { CALENDAR_ZONE } from '@/lib/time';

export function LocaleProvider({ locale, messages, children }: {
  locale: Locale;
  messages: ReturnType<typeof messagesForLocale>;
  children?: ReactNode;
}) {
  return <NextIntlClientProvider locale={locale} messages={messages} timeZone={CALENDAR_ZONE}>{children}</NextIntlClientProvider>;
}
