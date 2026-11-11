'use client';

import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import type { CSSProperties } from 'react';
import { Toaster as Sonner } from 'sonner';
import { Icon } from './icon';

const toastStyle: CSSProperties & Record<`--${string}`, string> = {
  fontFamily: 'inherit',
  '--normal-bg': 'var(--card)',
  '--normal-text': 'var(--foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': '10px',
};

export function Toaster() {
  const t = useTranslations('crew');
  const { theme } = useTheme();

  return <Sonner theme={theme === 'dark' || theme === 'light' ? theme : 'system'}
    className="toaster group" style={toastStyle}
    position="bottom-center" visibleToasts={2} closeButton
    containerAriaLabel={t('notifications')}
    toastOptions={{ closeButtonAriaLabel: t('dismissNotification') }}
    mobileOffset={{ bottom: 'max(16px, env(safe-area-inset-bottom))' }}
    icons={{
      success: <span className="text-[var(--success-fg)]"><Icon name="check" size={16} /></span>,
      error: <span className="text-[var(--danger-fg)]"><Icon name="alert" size={16} /></span>,
    }} />;
}
