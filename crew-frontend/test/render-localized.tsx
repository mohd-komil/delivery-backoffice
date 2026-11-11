import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { messagesForLocale } from '../src/shared/i18n/messages';

export function renderLocalized(children: ReactNode, locale: Parameters<typeof messagesForLocale>[0] = 'en') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="Europe/Rome" messages={messagesForLocale(locale)}>
      {children}
    </NextIntlClientProvider>,
  );
}
