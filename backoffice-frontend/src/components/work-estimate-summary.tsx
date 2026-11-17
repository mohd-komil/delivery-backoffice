'use client';

import { useTranslations } from 'next-intl';
import type { RemainingWorkEstimate } from '@/lib/contracts';

export function WorkEstimateSummary({ estimate, compact = false }: { estimate: RemainingWorkEstimate; compact?: boolean }) {
  const t = useTranslations('workTimeAdjustments');
  const calculation = estimate.calculation;
  if (!calculation) return null;
  const warning = calculation.adjustmentStatus === 'needs_review' || calculation.adjustmentStatus === 'incomplete';
  const status = [t(calculation.adjustmentStatus), calculation.adjustmentVersion === null ? null : t('revision', { version: calculation.adjustmentVersion })].filter(Boolean).join(' · ');
  const minutes = (value: number | null) => value === null ? t('unknown') : t('minutes', { count: value });
  const rows: { key: 'base' | 'factor' | 'fixed' | 'total'; value: string }[] = [
    { key: 'base', value: minutes(calculation.baseMinutes) },
    ...(calculation.adjustmentStatus === 'not_configured' ? [] : [
      { key: 'factor', value: calculation.factorPercent === null ? t('unknown') : `${calculation.factorPercent}%` } as const,
      { key: 'fixed', value: minutes(calculation.fixedMinutes) } as const,
    ]),
    { key: 'total', value: minutes(estimate.minutes) },
  ];
  if (compact) return <span className="mt-1 block text-xs text-muted-foreground">
    <span className={warning ? 'text-warning-foreground' : undefined}>{status}</span>
    {calculation.adjustmentStatus !== 'not_configured' ? <span className="mt-0.5 block tabular-nums">{rows.map((row) => `${t(row.key)} ${row.value}`).join(' · ')}</span> : null}
  </span>;
  return <div className="grid gap-3">
    <p role="status" className={`text-xs ${warning ? 'text-warning-foreground' : 'text-muted-foreground'}`}>{status}</p>
    <dl className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/25 p-3 sm:grid-cols-4">{rows.map((row) => <div key={row.key}>
      <dt className="text-xs text-muted-foreground">{t(row.key)}</dt>
      <dd className="mt-1 text-sm font-medium tabular-nums">{row.value}</dd>
    </div>)}</dl>
    {calculation.missingFields?.length ? <p className="text-xs text-warning-foreground">{t('missing', { fields: calculation.missingFields.map((field) => t(field === 'sourceEstimateExcludesAdjustments' ? 'sourceAck' : field)).join(', ') })}</p> : null}
  </div>;
}
