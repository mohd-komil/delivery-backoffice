'use client';

import { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { saveLocalePreference } from '@/i18n/actions';
import { commonTranslations } from '@/i18n/common';
import { isLocale, localeNames } from '@/i18n/config';

export function LanguageSelector() {
  const locale = useLocale();
  const t = useTranslations('common');
  const [pending, startTransition] = useTransition();

  function changeLanguage(value: string) {
    if (!isLocale(value) || value === locale) return;
    startTransition(async () => {
      try {
        if (await saveLocalePreference(value)) toast.success(commonTranslations(value)('languageSaved'));
        else toast.error(t('languageSaveFailed'));
      } catch {
        toast.error(t('languageSaveFailed'));
      }
    });
  }

  return <div className="language-control">
    <label className="theme-control">
      <span>{t('language')}</span>
      <select aria-label={t('language')} value={locale} disabled={pending} aria-busy={pending} onChange={(event) => changeLanguage(event.target.value)}>
        {Object.entries(localeNames).map(([code, name]) => <option value={code} lang={code} key={code}>{name}</option>)}
      </select>
    </label>
  </div>;
}
