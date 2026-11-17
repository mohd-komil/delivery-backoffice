'use client';

import { Combobox } from '@/shared/ui/combobox';


import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useSyncExternalStore, useTransition } from 'react';
import { saveCrewLocale } from '@/shared/i18n/actions';
import { localeNames } from '@/shared/i18n/config';
import { Icon } from './icon';

const subscribe = () => () => undefined;
const mountedSnapshot = () => true;
const serverSnapshot = () => false;

export function Preferences() {
  const t = useTranslations('crew');
  const locale = useLocale();
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, mountedSnapshot, serverSnapshot);
  const [pending, startTransition] = useTransition();

  return <div className="preferences" role="group" aria-label={t('preferences')}>
    <label>
      <span>{t('language')}</span>
      <Combobox value={locale} disabled={pending} onChange={(event) => {
        const value = event.currentTarget.value;
        startTransition(() => saveCrewLocale(value));
      }}>
        {Object.entries(localeNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </Combobox>
    </label>
    <label>
      <span>{t('theme')}</span>
      <Combobox value={mounted ? theme ?? 'system' : 'system'} disabled={!mounted} onChange={(event) => setTheme(event.currentTarget.value)}>
        <option value="system">{t('system')}</option>
        <option value="light">{t('light')}</option>
        <option value="dark">{t('dark')}</option>
      </Combobox>
    </label>
  </div>;
}

export function InstallHelp() {
  const t = useTranslations('crew');

  return <details className="install-help">
    <summary>
      <Icon name="mobile" />
      <span>{t('installTitle')}</span>
      <Icon name="chevron" size={16} />
    </summary>
    <div>
      <p>{t('installDescription')}</p>
      <p>{t('installIphone')}</p>
      <p>{t('installAndroid')}</p>
    </div>
  </details>;
}
