'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { apiRequest, errorMessage } from '@/lib/api';
import { calendarSchema, type CalendarEntry } from '@/lib/contracts';
import { calendarDay, calendarDayBounds, formatDateTime } from '@/lib/time';
import { visitConfirmationState } from '@/lib/visit-confirmation';
import { Empty, Notice, Pending } from './ui';
import { StaffingEditor } from './staffing-editor';
import { VisitConfirmationBadge } from './visit-confirmation-badge';
import { PageHeadingTitle } from './page-help';
import { DataTable } from './ui/data-table';

export function Staffing({ onOpen }: { onOpen: (deliveryId: string) => void }) {
  const t = useTranslations('directory');
  const locale = useLocale();
  const [day, setDay] = useState(() => calendarDay(new Date().toISOString()));
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [failureState, setFailureState] = useState<{ cause: unknown } | null>(null);
  const error = failureState ? errorMessage(failureState.cause, locale) : null;
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ deliveryId: string; appointmentId: string } | null>(null);
  const requestKey = `${day}/${revision}`;
  const loading = settled !== requestKey;
  function refresh() { setRevision((value) => value + 1); }
  useEffect(() => {
    const controller = new AbortController();
    const bounds = calendarDayBounds(day);
    const query = new URLSearchParams({ from: new Date(bounds.start).toISOString(), to: new Date(bounds.end).toISOString() });
    void apiRequest(`/calendar?${query}`, calendarSchema, { signal: controller.signal }).then(
      (value) => { if (!controller.signal.aborted) { setEntries(value); setFailureState(null); setSettled(requestKey); } },
      (failure: unknown) => { if (!controller.signal.aborted) { setFailureState({ cause: failure }); setSettled(requestKey); } },
    );
    return () => controller.abort();
  }, [day, requestKey]);
  const booked = entries?.filter((entry) => entry.appointment.status === 'booked') ?? [];
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('staffingEyebrow')}</p><PageHeadingTitle title={t('staffingTitle')} topic="staffing" /><p className="subtitle">{t('staffingSubtitle')}</p></div><div className="calendar-controls"><button className="button secondary" disabled={loading} onClick={refresh}>{t('refreshStaffing')}</button><label className="sr-only" htmlFor="staffing-date">{t('staffingDate')}</label><input id="staffing-date" type="date" value={day} onChange={(event) => { if (event.target.value) setDay(event.target.value); }} /></div></div>
    <Notice>{t('staffingIntro')}</Notice>
    <div className="mb-3 flex h-10 items-center gap-3 text-xs" role="status" aria-live="polite">{error ? <><span className="max-h-10 flex-1 overflow-y-auto text-destructive">{error}{entries ? " " + t('previousVisits') : ''}</span><button className="text-button" disabled={loading} onClick={refresh}>{t('retryStaffing')}</button></> : <span className="muted">{entries && loading ? t('refreshingStaffing') : ''}</span>}</div>
    {!entries && loading ? <Pending>{t('loadingBookedVisits')}</Pending> : null}
    {entries ? <>
      <DataTable
        caption={t('staffingCaption')}
        containerClassName="table-wrap relative staffing-table-region"
        className="staffing-table min-w-[880px]"
        resetKey={day}
        header={<tr>
          <th scope="col">{t('deliveryCustomer')}</th>
          <th scope="col">{t('visitInterval')}</th>
          <th scope="col">{t('crew')}</th>
          <th scope="col">{t('actualParticipants')}</th>
          <th scope="col"><span className="sr-only">{t('manageStaffing')}</span></th>
        </tr>}
        rows={booked.flatMap((entry) => entry.appointment.assignments.length ? entry.appointment.assignments.map((assignment) => (
          <tr key={`${entry.appointment.id}/${assignment.id}`}>
            <td>
              <button className="reference" onClick={() => onOpen(entry.deliveryId)}>{entry.pickingName}</button>
              <span className="cell-sub">{entry.customerName}</span>
            </td>
            <td>
              {formatDateTime(entry.appointment.startsAt, locale)}
              <span className="cell-sub">{t('staffingUntil', { date: formatDateTime(entry.appointment.endsAt, locale) })}</span>
              <VisitConfirmationBadge state={visitConfirmationState(entry.appointment, true)} className="mt-1" />
            </td>
            <td>{assignment.crewName}</td>
            <td><div className="flex max-w-sm flex-wrap gap-2">{assignment.people.map((person) => (
              <span key={person.id}>{person.name}{person.external ? <span className="badge neutral ml-1">{t('external')}</span> : null}</span>
            ))}</div></td>
            <td><button className="button secondary small" aria-label={t('editStaffNamed', { picking: entry.pickingName, crew: assignment.crewName })} onClick={() => setEditing({ deliveryId: entry.deliveryId, appointmentId: entry.appointment.id })}>{t('editStaff')}</button></td>
          </tr>
        )) : [<tr key={entry.appointment.id}>
          <td>
            <button className="reference" onClick={() => onOpen(entry.deliveryId)}>{entry.pickingName}</button>
            <span className="cell-sub">{entry.customerName}</span>
          </td>
          <td>
            {formatDateTime(entry.appointment.startsAt, locale)}
            <span className="cell-sub">{t('staffingUntil', { date: formatDateTime(entry.appointment.endsAt, locale) })}</span>
          </td>
          <td colSpan={2} className="muted">{t('noAssignedCrew')}</td>
          <td><button className="button secondary small" onClick={() => onOpen(entry.deliveryId)}>{t('openDelivery')}</button></td>
        </tr>])}
      />
      {booked.length === 0 ? <Empty title={t('noVisitsOnDate')}>{t('chooseAnotherDate')}</Empty> : null}
    </> : null}
    {editing ? <StaffingEditor key={editing.appointmentId} {...editing} onClose={() => setEditing(null)} onChanged={refresh} /> : null}
  </>;
}
