import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { createTranslator } from 'next-intl';
import { getCrewLocale } from '@/shared/i18n/request';
import { messagesForLocale } from '@/shared/i18n/messages';
import { Providers } from '@/shared/ui/providers';
import { RegisterWorker } from '@/shared/pwa/register-worker';
import './globals.css';

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f7fa' },
    { media: '(prefers-color-scheme: dark)', color: '#11141a' },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getCrewLocale();
  const t = createTranslator({ locale, messages: messagesForLocale(locale), namespace: 'crew' });
  return { title: t('brand'), description: t('metadataDescription'), robots: { index: false, follow: false } };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getCrewLocale();
  const messages = messagesForLocale(locale);
  const t = createTranslator({ locale, messages, namespace: 'crew' });
  return <html lang={locale} className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
    <body>
      <a href="#main-content" className="skip-link">{t('skipToContent')}</a>
      <Providers locale={locale} messages={messages}>{children}</Providers>
      <RegisterWorker />
    </body>
  </html>;
}
