import type { Metadata } from 'next';
import { createTranslator } from 'next-intl';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { ThemeProvider } from '@/components/theme-provider';
import { LocaleProvider } from '@/components/locale-provider';
import { Toaster } from '@/components/ui/sonner';
import { getRequestLocale } from '@/i18n/request';
import { messagesForLocale } from '@/i18n/messages';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const t = createTranslator({ locale, messages: messagesForLocale(locale), namespace: 'workspace' });
  return { title: t('metadataTitle'), description: t('metadataDescription') };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getRequestLocale();
  return <html lang={locale} className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
    <body><LocaleProvider locale={locale} messages={messagesForLocale(locale)}><ThemeProvider>{children}<Toaster /></ThemeProvider></LocaleProvider></body>
  </html>;
}
