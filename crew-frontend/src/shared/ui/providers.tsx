'use client';

import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';
import { crewTimeZone, type Locale } from '@/shared/i18n/config';
import type { messagesForLocale } from '@/shared/i18n/messages';
import { Toaster } from './sonner';

export function Providers({ locale, messages, children }: {
  locale: Locale;
  messages: ReturnType<typeof messagesForLocale>;
  children: ReactNode;
}) {
  return <NextIntlClientProvider locale={locale} messages={messages} timeZone={crewTimeZone}>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="crew-theme" disableTransitionOnChange>
      {children}
      <Toaster />
    </ThemeProvider>
  </NextIntlClientProvider>;
}
