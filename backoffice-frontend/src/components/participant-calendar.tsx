'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiRequest, errorMessage } from '@/lib/api';
import { participantCalendarSchema, type ParticipantCalendarData } from '@/lib/contracts';
import { calendarDay, formatDateTime } from '@/lib/time';
import { CalendarTimeGrid } from './calendar-time-grid';
import { CalendarMonthGrid } from './calendar-month-grid';
import { CalendarControls } from './calendar-controls';
import { PageHeadingTitle } from './page-help';
import { calendarPeriodDays, calendarPeriodRange, DEFAULT_CALENDAR_MODE, type CalendarMode } from '@/lib/calendar-period';
import { visitConfirmationState } from '@/lib/visit-confirmation';
import { Empty, Notice, Pending } from './ui';
import { Input } from './ui/input';
import { RecordedSkillBadges } from './skill-choices';
import { VisitConfirmationBadge } from './visit-confirmation-badge';
import { Card } from './ui/card';

type CalendarFailure = { owner: string } & (
  { kind: 'mismatchedParticipant' } | { kind: 'request'; cause: unknown }
);

export function ParticipantCalendar({ participantId, refreshKey, onOpen }: { participantId: string; refreshKey: number; onOpen: (deliveryId: string) => void }) {
  const t = useTranslations('calendar');
  const publicationText = useTranslations('routePublication');
  const locale = useLocale();
  const [mode, setMode] = useState<CalendarMode>(DEFAULT_CALENDAR_MODE);
  const [anchor, setAnchor] = useState(() => calendarDay(new Date().toISOString()));
  const [showCancelled, setShowCancelled] = useState(false);
  const [resource, setResource] = useState<{ owner: string; data: ParticipantCalendarData } | null>(null);
  const [failure, setFailure] = useState<CalendarFailure | null>(null);
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<string | null>(null);
  const days = calendarPeriodDays(anchor, mode);
  const first = days[0] ?? anchor;
  const last = days[days.length - 1] ?? anchor;
  const requestKey = `${participantId}/${first}/${last}/${refreshKey}/${revision}`;
  const loading = settled !== requestKey;
  const data = resource?.owner === participantId ? resource.data : null;
  const currentFailure = failure?.owner === participantId ? failure : null;
  const error = currentFailure?.kind === 'request'
    ? errorMessage(currentFailure.cause, locale)
    : currentFailure ? t('participantMismatch') : null;
  const { from, to } = calendarPeriodRange(days);

  function refresh() { setRevision((value) => value + 1); }
  function chooseDay(day: string) { setAnchor(day); setMode('day'); }
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ from, to });
    void apiRequest(`/participants/${participantId}/calendar?${query}`, participantCalendarSchema, { signal: controller.signal }).then(
      (value) => {
        if (controller.signal.aborted) return;
        if (value.participant.id !== participantId) {
          setFailure({ owner: participantId, kind: 'mismatchedParticipant' });
          setSettled(requestKey);
          return;
        }
        setResource({ owner: participantId, data: value }); setFailure(null); setSettled(requestKey);
      },
      (cause: unknown) => { if (!controller.signal.aborted) { setFailure({ owner: participantId, kind: 'request', cause }); setSettled(requestKey); } },
    );
    return () => controller.abort();
  }, [participantId, from, to, requestKey]);
  const visible = data?.entries.filter((entry) => (showCancelled || entry.status !== 'cancelled') && Date.parse(entry.startsAt) < Date.parse(to) && Date.parse(entry.endsAt) > Date.parse(from))
    .map((entry) => ({ ...entry, confirmationState: visitConfirmationState(entry, true) })) ?? [];
  const blocks = visible.map((entry) => ({
    id: `${entry.appointmentId}/${entry.assignment.id}`,
    deliveryId: entry.deliveryId,
    startsAt: entry.startsAt,
    endsAt: entry.endsAt,
    status: entry.status,
    confirmationState: entry.confirmationState,
    title: entry.pickingName,
    subtitle: entry.assignment.crewName,
    detail: entry.assignment.tasks.map((task) => task.title).join(' · ') || t('noSavedTasksShort'),
  }));

  return <>
    <Link href="/?section=directory&tab=participants" className="text-button mb-4 inline-flex">{t('backToParticipants')}</Link>
    <div className="page-heading"><div className="min-w-0 [overflow-wrap:anywhere]">
      <p className="eyebrow">{t('actualAssignments')}</p>
      <PageHeadingTitle title={t('participantCalendarTitle')} topic="participantCalendar" />
      <p className="subtitle">{data ? data.participant.name : t('loadingParticipant')} · Europe/Rome</p>
      {data ? <div className="mt-2 flex flex-wrap gap-2">
        <span className="badge neutral">{t(data.participant.external ? 'external' : 'internal')}</span>
        <span className={data.participant.enabled ? 'badge success' : 'badge warning'}>{t(data.participant.enabled ? 'enabled' : 'disabledForStaffing')}</span>
      </div> : null}
    </div></div>
    <CalendarControls anchor={anchor} mode={mode} onAnchorChange={setAnchor} onModeChange={setMode} onRefresh={refresh} refreshing={loading} idPrefix="participant-calendar" refreshLabel={t('refreshCalendar')} />
    <label className="checkbox-label mb-4">
      <Input type="checkbox" name="showCancelled" checked={showCancelled} onChange={(event) => setShowCancelled(event.target.checked)} />
      {t('showCancelled')}
    </label>
    <Notice>{t('participantNotice')}</Notice>
    <div className="mb-3 flex h-10 items-center gap-3 text-xs" role="status" aria-live="polite">
      {error ? <>
        <span className="max-h-10 flex-1 overflow-y-auto text-destructive">{error}{data ? ` ${t('previousVisits')}` : ''}</span>
        <button className="text-button" disabled={loading} onClick={refresh}>{t('retryCalendar')}</button>
      </> : <span className="muted">{loading && data ? t('refreshingCalendar') : ''}</span>}
    </div>
    {!data && loading ? <Pending>{t('loadingParticipantCalendar')}</Pending> : null}
    {data ? <>
      {data.routeReservations?.length ? <Card className="mb-4 grid gap-3 border-info-foreground/30 p-4">
        <h2 className="font-semibold">{publicationText('routeOccupancy')}</h2><p className="text-sm text-muted-foreground">{publicationText('routeOccupancyHelp')}</p>
        <ul className="grid gap-3 sm:grid-cols-2">{data.routeReservations.map((reservation) => <li key={reservation.routeId} className="rounded-md border bg-info/30 p-3">
          <strong className="break-words">{reservation.name}</strong><span className="badge info ml-2">{publicationText(`routeState_${reservation.status}`)}</span>
          <p className="mt-2 font-mono text-xs">{formatDateTime(reservation.startsAt, locale)} → {formatDateTime(reservation.endsAt, locale)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{publicationText('routeBuffer', { minutes: reservation.bufferMinutes })}</p>
        </li>)}</ul>
      </Card> : null}
      {mode === 'month' ? <CalendarMonthGrid anchor={anchor} days={days} entries={blocks} onOpen={onOpen} onChooseDay={chooseDay} /> : <CalendarTimeGrid days={days} entries={blocks} onOpen={onOpen} />}
      <section className="section-gap participant-visits">
        <div className="section-title"><h2>{t('visitsAndTasks')}</h2><span className="badge neutral">{visible.length}</span></div>
        {visible.length === 0 ? <Empty title={t('noRecordedVisits')}>{t('noRecordedVisitsHint')}</Empty> : visible.map((entry) => (
          <article key={`${entry.appointmentId}/${entry.assignment.id}`} data-appointment-id={entry.appointmentId} className="visit-card">
            <div className="section-title">
              <div className="min-w-0 [overflow-wrap:anywhere]"><h3>{entry.pickingName}</h3><span className="cell-sub">{entry.customerName}</span></div>
              <div className="flex flex-wrap gap-2">
                <span className="badge neutral">{t(entry.status)}</span>
                <VisitConfirmationBadge state={entry.confirmationState} />
                {entry.returnVisit ? <span className="badge warning">{t('returnVisit')}</span> : null}
              </div>
            </div>
            <p className="visit-time">{formatDateTime(entry.startsAt, locale)}<span>→ {formatDateTime(entry.endsAt, locale)}</span></p>
            <p className="small"><strong>{t('savedCrew', { crew: entry.assignment.crewName })}</strong></p>
            <p className="small muted">{t('savedParticipants', {
              participants: entry.assignment.people.map((person) => person.external ? t('externalName', { name: person.name }) : person.name).join(', '),
            })}</p>
            <h4 className="mt-4">{t('savedCrewTasks')}</h4>
            {entry.assignment.tasks.length === 0 ? <p className="small muted">{t('noSavedTasks')}</p> : (
              <ul className="my-3 space-y-3">{entry.assignment.tasks.toSorted((left, right) => left.order - right.order).map((task) => (
                <li key={task.id} className="rounded-md border border-border p-3">
                  <div className="card-topline">
                    <strong>{task.title}</strong>
                    <span className="muted small">{t('severityAndOrder', { severity: t(task.severity), order: task.order })}</span>
                  </div>
                  <RecordedSkillBadges skills={task.requiredSkillsSnapshot} />
                  <ul className="task-checklist">{task.checklist.map((checkpoint) => {
                    const status = t(checkpoint.done ? 'checkpointCompleted' : checkpoint.waiver ? 'checkpointWaived' : 'checkpointPending');
                    return <li key={checkpoint.id}>
                      <span className={checkpoint.done || checkpoint.waiver ? 'check done' : 'check'} aria-label={status}>{checkpoint.done ? '✓' : checkpoint.waiver ? '−' : ''}</span>
                      <span>{checkpoint.label}<small className="cell-sub">{!checkpoint.done && checkpoint.waiver ? t('checkpointWaiverReason', { reason: checkpoint.waiver.reason }) : status}</small></span>
                    </li>;
                  })}</ul>
                </li>
              ))}</ul>
            )}
            <button className="button secondary small" onClick={() => onOpen(entry.deliveryId)}>{t('openDelivery')}</button>
          </article>
        ))}
      </section>
    </> : !loading ? <Empty title={t('calendarUnavailable')}>{t('calendarUnavailableHint')}</Empty> : null}
  </>;
}


