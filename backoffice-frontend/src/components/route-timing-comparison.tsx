'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { ApiError, apiRequest, errorMessage } from '@/lib/api';
import { routeTimingSchema, type RouteTiming } from '@/lib/route-timing';
import { formatDateTime } from '@/lib/time';
import { Notice } from './ui';

type TimingResult = { key: string; data: RouteTiming | null; error: unknown };

const routeRows = [
  ['timingDeparture', 'departAt'],
  ['timingReturnDeparture', 'returnDepartAt'],
  ['timingReturn', 'returnAt'],
  ['timingAllTravel', 'travelMinutes'],
  ['timingWaiting', 'waitingMinutes'],
  ['timingWork', 'workMinutes'],
  ['timingReturnTravel', 'returnTravelMinutes'],
  ['timingTotal', 'totalMinutes'],
] as const satisfies ReadonlyArray<readonly [string, keyof RouteTiming['route']]>;

const stopRows = [
  ['timingArrival', 'arrivalAt'],
  ['timingWorkStart', 'workStartAt'],
  ['timingWorkEnd', 'workEndAt'],
  ['timingTravel', 'travelMinutes'],
  ['timingWaiting', 'waitingMinutes'],
  ['timingWork', 'workMinutes'],
] as const satisfies ReadonlyArray<readonly [string, keyof RouteTiming['stops'][number]]>;

const reasonLabels = {
  skipped: 'skipped',
  customer_absent: 'timingCustomerAbsent',
  cancelled: 'cancelled',
} as const;

export function RouteTimingComparison({ routeId, refreshKey }: { routeId: string; refreshKey: string }) {
  const t = useTranslations('routeOperations');
  const calendar = useTranslations('calendar');
  const locale = useLocale();
  const [result, setResult] = useState<TimingResult | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest(`/routes/${routeId}/timing`, routeTimingSchema.refine((value) => value.id === routeId), { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setResult({ key: refreshKey, data, error: null });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setResult((previous) => ({
        key: refreshKey,
        data: error instanceof ApiError && [401, 403, 404].includes(error.status) ? null :
          previous?.data?.id === routeId ? previous.data : null,
        error,
      }));
    });
    return () => controller.abort();
  }, [routeId, refreshKey]);

  const loading = result?.key !== refreshKey;
  const data = result?.data ?? null;

  return <section className="grid min-w-0 gap-4" aria-label={t('timing')} aria-busy={loading}>
    {loading ? <p role="status" className="text-sm text-muted-foreground">{t('timingLoading')}</p> : null}
    {result?.error && !loading ? <Notice tone="error">{t(data ? 'timingRefreshFailed' : 'timingUnavailable')} {errorMessage(result.error, locale)}</Notice> : null}
    {data ? <>
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold">{t('timingRoute')}</h3>
        <p className="text-sm text-muted-foreground">{t('timingPlanReference', { version: data.plan.version, at: formatDateTime(data.plan.at, locale) })}</p>
        <p className="text-sm text-muted-foreground">{t('timingExplanation')}</p>
        <p className="text-sm text-muted-foreground">{t('timingNoArrivalActual')}</p>
      </div>
      <TimingTable caption={t('timingRoute')} rows={routeRows.map(([label, metric]) => ({ label: t(label), ...data.route[metric] }))} />
      <div className="grid min-w-0 gap-2">
        <h3 className="text-sm font-semibold">{t('timingStops')}</h3>
        {!data.stops.length ? <p className="text-sm text-muted-foreground">{t('timingNoStops')}</p> : null}
        {data.stops.map((stop) => {
          const title = t('timingStop', { sequence: stop.sequence, name: stop.pickingName });
          const reason = stop.reason;
          return <details className="min-w-0 rounded-lg border border-border bg-card" key={stop.appointmentId}>
            <summary className="cursor-pointer rounded-lg p-3 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
              {title} <span className="text-muted-foreground">· {reason ? t(reasonLabels[reason.kind]) : calendar(stop.status)}</span>
            </summary>
            <div className="grid min-w-0 gap-3 px-3 pb-3">
              {reason?.note ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{reason.note}</p> : null}
              <TimingTable caption={title} rows={stopRows.map(([label, metric]) => ({ label: t(label), ...stop[metric] }))} />
            </div>
          </details>;
        })}
      </div>
    </> : null}
  </section>;
}

type TimingRow = { label: string; planned: string | number | null; actual: string | number | null; deltaMinutes: number | null };

function TimingTable({ caption, rows }: { caption: string; rows: readonly TimingRow[] }) {
  const t = useTranslations('routeOperations');
  const formatter = useFormatter();
  const locale = useLocale();
  const minutes = (value: number, signed = false) => t('timingMinutes', {
    minutes: formatter.number(value, { maximumFractionDigits: 1, signDisplay: signed ? 'exceptZero' : 'auto' }),
  });
  const missing = <><span aria-hidden="true">—</span><span className="sr-only">{t('timingMissing')}</span></>;
  const renderValue = (value: string | number | null) => value === null ? missing :
    typeof value === 'number' ? minutes(value) : <time dateTime={value}>{formatDateTime(value, locale)}</time>;
  return <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
    <table className="min-w-[440px]">
      <caption className="sr-only">{caption}</caption>
      <thead><tr>
        <th scope="col">{t('timingMetric')}</th>
        <th scope="col">{t('planned')}</th>
        <th scope="col">{t('timingActual')}</th>
        <th scope="col">{t('timingDifference')}</th>
      </tr></thead>
      <tbody>{rows.map(({ label, planned, actual, deltaMinutes }) => <tr key={label}>
        <th className="bg-transparent text-xs font-medium tracking-normal text-foreground normal-case" scope="row">{label}</th>
        <td className="tabular-nums">{renderValue(planned)}</td>
        <td className="tabular-nums">{renderValue(actual)}</td>
        <td className={deltaMinutes !== null && deltaMinutes > 0 ? 'whitespace-nowrap font-medium text-warning-foreground tabular-nums' : 'whitespace-nowrap tabular-nums'}>
          {deltaMinutes === null ? missing : minutes(deltaMinutes, true)}
        </td>
      </tr>)}</tbody>
    </table>
  </div>;
}
