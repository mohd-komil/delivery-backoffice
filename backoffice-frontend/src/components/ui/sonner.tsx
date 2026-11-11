'use client';

import type { CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { Toaster as Sonner } from 'sonner';

const appearance: CSSProperties & Record<`--${string}`, string> = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': 'var(--radius)',
  '--success-bg': 'var(--success)',
  '--success-text': 'var(--success-foreground)',
  '--success-border': 'var(--border)',
  '--error-bg': 'var(--danger)',
  '--error-text': 'var(--destructive)',
  '--error-border': 'var(--border)',
  '--warning-bg': 'var(--warning)',
  '--warning-text': 'var(--warning-foreground)',
  '--warning-border': 'var(--border)',
  '--info-bg': 'var(--info)',
  '--info-text': 'var(--info-foreground)',
  '--info-border': 'var(--border)',
};

export function Toaster() {
  const { resolvedTheme } = useTheme();
  const t = useTranslations('common');
  return <Sonner
    theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
    className="toaster"
    position="bottom-right"
    containerAriaLabel={t('notifications')}
    richColors
    style={appearance}
  />;
}
