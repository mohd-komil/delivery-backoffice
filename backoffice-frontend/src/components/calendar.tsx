'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiRequest, errorMessage } from '@/lib/api';
import { calendarFilterCatalogSchema, calendarSchema, type CalendarEntry, type CalendarFilterCatalog } from '@/lib/contracts';
import { calendarDay, formatDateTime } from '@/lib/time';
import { calendarPeriodDays, calendarPeriodRange, DEFAULT_CALENDAR_MODE, type CalendarMode } from '@/lib/calendar-period';
import { visitConfirmationState } from '@/lib/visit-confirmation';
import { calendarFilterOptions, changeCalendarGeography, filterCalendarEntries, type CalendarFilters as CalendarFilterValues } from '@/lib/calendar-filters';
import { Empty, Pending } from './ui';
import { CalendarTimeGrid } from './calendar-time-grid';
import { CalendarMonthGrid } from './calendar-month-grid';
import { CalendarControls } from './calendar-controls';
import { CalendarFilters } from './calendar-filters';
import { PageHeadingTitle } from './page-help';
import { VisitConfirmationBadge } from './visit-confirmation-badge';
import { DataTable } from './ui/data-table';

const emptyCatalog: CalendarFilterCatalog = { destinations: [], crews: [] };

export function Calendar({ refreshKey, onOpen }: { refreshKey: number; onOpen: (id: string) => void }) {
  const t = useTranslations('calendar');
  const locale = useLocale();
  const [mode, setMode] = useState<CalendarMode>(DEFAULT_CALENDAR_MODE);
  const [anchor, setAnchor] = useState(() => calendarDay(new Date().toISOString()));
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [filters, setFilters] = useState<CalendarFilterValues>({ customerName: '' });
  const [catalog, setCatalog] = useState<CalendarFilterCatalog | null>(null);
  const [catalogFailure, setCatalogFailure] = useState<{ cause: unknown } | null>(null);
  const [settledCatalogRequest, setSettledCatalogRequest] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const [revision, setRevision] = useState(0);
  const [settledRequest, setSettledRequest] = useState<string | null>(null);
  const days = calendarPeriodDays(anchor, mode);
  const { from, to } = calendarPeriodRange(days);
  const requestKey = `${from}/${to}/${refreshKey}/${revision}`;
  const catalogRequestKey = `${refreshKey}/${revision}`;
  const catalogLoading = settledCatalogRequest !== catalogRequestKey;
  const loading = settledRequest !== requestKey || catalogLoading;
  const error = failure ? errorMessage(failure.cause, locale) : null;
  function refreshCalendar() { setRevision((value) => value + 1); }
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ from, to });
    void apiRequest(`/calendar?${query}`, calendarSchema, { signal: controller.signal }).then(
      (result) => { if (!controller.signal.aborted) { setEntries(result); setFailure(null); setSettledRequest(requestKey); } },
      (cause: unknown) => { if (!controller.signal.aborted) { setFailure({ cause }); setSettledRequest(requestKey); } },
    );
    return () => controller.abort();
  }, [from, to, requestKey]);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest('/calendar/filter-options', calendarFilterCatalogSchema, { signal: controller.signal }).then(
      (result) => { if (!controller.signal.aborted) { setCatalog(result); setCatalogFailure(null); setSettledCatalogRequest(catalogRequestKey); } },
      (cause: unknown) => { if (!controller.signal.aborted) { setCatalogFailure({ cause }); setSettledCatalogRequest(catalogRequestKey); } },
    );
    return () => controller.abort();
  }, [catalogRequestKey]);
  const periodEntries = entries?.filter((entry) => entry.appointment.status !== 'cancelled' && Date.parse(entry.appointment.startsAt) < Date.parse(to) && Date.parse(entry.appointment.endsAt) > Date.parse(from)) ?? [];
  const visible = filterCalendarEntries(periodEntries, filters)
    .map((entry) => ({ ...entry, confirmationState: visitConfirmationState(entry.appointment, entry.appointment.assignments.length > 0) }));
  const options = calendarFilterOptions(catalog ?? emptyCatalog, filters);
  const activeFilters = filters.city !== undefined || filters.province !== undefined || filters.postalCode !== undefined || filters.crewId !== undefined || filters.customerName.trim().length > 0;
  const blocks = visible.map((entry) => ({
    id: entry.appointment.id,
    deliveryId: entry.deliveryId,
    startsAt: entry.appointment.startsAt,
    endsAt: entry.appointment.endsAt,
    status: entry.appointment.status,
    confirmationState: entry.confirmationState,
    title: entry.pickingName,
    subtitle: entry.customerName,
    detail: entry.appointment.assignments.map((assignment) => {
      const tasks = assignment.tasks.map((task) => task.title).join(', ');
      return tasks ? `${assignment.crewName} · ${tasks}` : assignment.crewName;
    }).join('; ') || t('noCrewAssigned'),
  }));
  function chooseDay(day: string) { setAnchor(day); setMode('day'); }

  return <>
    <div className="page-heading"><div>
      <p className="eyebrow">{t('resourcePlanning')}</p>
      <PageHeadingTitle title={t('calendarTitle')} topic="calendar" />
      <p className="subtitle">{t('calendarSubtitle')}</p>
    </div></div>
    <CalendarControls anchor={anchor} mode={mode} onAnchorChange={setAnchor} onModeChange={setMode} onRefresh={refreshCalendar} refreshing={loading} idPrefix="calendar" refreshLabel={t('refresh')} />
    <CalendarFilters filters={filters} options={options} shown={visible.length} total={periodEntries.length} onChange={setFilters}
      available={catalog !== null} loading={catalogLoading} error={catalogFailure ? errorMessage(catalogFailure.cause, locale) : null} onRetry={refreshCalendar}
      onGeographyChange={(key, value) => setFilters((current) => changeCalendarGeography(catalogLoading || catalogFailure ? emptyCatalog : catalog ?? emptyCatalog, current, key, value))} />
    <div className="mb-3 flex h-10 items-center gap-3 text-xs" aria-live="polite" role="status">
      {error && !loading ? <>
        <span className="max-h-10 flex-1 overflow-y-auto text-destructive">{error} {entries ? t('previousBookings') : ''}</span>
        <button className="text-button" onClick={refreshCalendar}>{t('retry')}</button>
      </> : <span className="text-muted-foreground">{loading && entries ? t('refreshingBookings') : ''}</span>}
    </div>
    {!entries && loading ? <Pending>{t('loadingBookings')}</Pending> : null}
    <div className="calendar-legend">
      <span><i className="legend-dot booked" />{t('legendBooked')}</span>
      <span><i className="legend-dot in_progress" />{t('legendInProgress')}</span>
      <span><i className="legend-dot completed" />{t('legendCompleted')}</span>
      <span className="muted">{t('concurrentVisits')}</span>
    </div>
    {mode === 'month' ? <CalendarMonthGrid anchor={anchor} days={days} entries={blocks} onOpen={onOpen} onChooseDay={chooseDay} /> : <CalendarTimeGrid days={days} entries={blocks} onOpen={onOpen} />}
    <section className="section-gap">
      <div className="section-title"><h2>{t('appointmentsInView')}</h2><span className="badge neutral">{visible.length}</span></div>
      {visible.length === 0 ? <Empty title={t(activeFilters ? 'noMatchingAppointments' : 'noAppointments')}>{t(activeFilters ? 'filterEmptyHelp' : 'bookNextVisit')}</Empty> : (
        <DataTable
          caption={t('appointmentsInView')}
          containerClassName="table-wrap relative"
          className="min-w-[720px]"
          resetKey={`${mode}/${from}/${to}/${JSON.stringify(filters)}`}
          header={<tr><th scope="col">{t('delivery')}</th><th scope="col">{t('customer')}</th><th scope="col">{t('appointment')}</th><th scope="col">{t('crews')}</th><th scope="col">{t('status')}</th></tr>}
          rows={visible.map((entry) => (
              <tr key={entry.appointment.id}>
                <td><button className="reference" onClick={() => onOpen(entry.deliveryId)}>{entry.pickingName}</button></td>
                <td>{entry.customerName}</td>
                <td>{formatDateTime(entry.appointment.startsAt, locale)}<span className="cell-sub">{t('until', { time: formatDateTime(entry.appointment.endsAt, locale) })}</span></td>
                <td>{entry.appointment.assignments.map((assignment) => assignment.crewName).join(', ') || t('notStaffed')}</td>
                <td><div className="flex flex-wrap items-start gap-1">
                  <span className="badge neutral">{t(entry.appointment.status)}</span>
                  <VisitConfirmationBadge state={entry.confirmationState} />
                </div></td>
              </tr>
            ))}
        />
      )}
    </section>
  </>;
}


