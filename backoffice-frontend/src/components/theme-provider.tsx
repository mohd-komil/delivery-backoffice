'use client';

import { Combobox } from './ui/combobox';


import { ThemeProvider as NextThemeProvider, useTheme } from 'next-themes';
import { useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

export function ThemeProvider({ children }: { children: ReactNode }) {
  return <NextThemeProvider attribute="class" defaultTheme="system" enableSystem themes={['light', 'dark']} storageKey="delivery-backoffice-theme">{children}</NextThemeProvider>;
}

const subscribe = () => () => undefined;
const mountedSnapshot = () => true;
const serverSnapshot = () => false;
export function ThemeSelector() {
  const t = useTranslations('common');
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, mountedSnapshot, serverSnapshot);
  return <label className="theme-control"><span>{t('theme')}</span><Combobox aria-label={t('appearanceTheme')} value={mounted ? theme ?? 'system' : 'system'} disabled={!mounted} onChange={(event) => setTheme(event.target.value)}><option value="system">{t('system')}</option><option value="light">{t('light')}</option><option value="dark">{t('dark')}</option></Combobox></label>;
}
