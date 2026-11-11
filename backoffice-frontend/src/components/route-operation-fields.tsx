'use client';

import { useTranslations } from 'next-intl';
import { Input } from './ui/input';

export function RouteAttestations({ value, onChange }: { value?: { notDeparted: boolean; notLoaded: boolean }; onChange?: (value: { notDeparted: boolean; notLoaded: boolean }) => void } = {}) {
  const t = useTranslations('routeOperations');
  return <div className="my-3 grid gap-3"><label className="flex items-start gap-2 text-sm"><Input type="checkbox" name="notDeparted" required checked={value?.notDeparted} onChange={onChange ? (event) => onChange({ notDeparted: event.target.checked, notLoaded: value?.notLoaded ?? false }) : undefined} />{t('notDeparted')}</label><label className="flex items-start gap-2 text-sm"><Input type="checkbox" name="notLoaded" required checked={value?.notLoaded} onChange={onChange ? (event) => onChange({ notDeparted: value?.notDeparted ?? false, notLoaded: event.target.checked }) : undefined} />{t('notLoaded')}</label></div>;
}
