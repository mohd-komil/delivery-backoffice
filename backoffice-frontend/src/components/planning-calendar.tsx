'use client';

import { Combobox } from './ui/combobox';


import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { participantSchema, type Participant } from '@/lib/contracts';
import { planningCalendarDetailSchema, planningCalendarFieldsSchema, planningCalendarKindSchema, planningCalendarSchema, type PlanningCalendarEntry } from '@/lib/planning-calendar';
import { calendarDay, formatDateTime, parseBookingInstant } from '@/lib/time';
import { calendarPeriodDays, calendarPeriodRange, DEFAULT_CALENDAR_MODE, type CalendarMode } from '@/lib/calendar-period';
import { CalendarControls } from './calendar-controls';
import { DateTimeFields } from './date-time-fields';
import { ActionForm, Empty, Field, textField } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DataTable } from './ui/data-table';
import { PlanningEditor, PlanningHistory, PlanningReadState, PlanningReason, usePlanningCommand, usePlanningRead } from './planning-reference-common';

const peopleSchema = z.array(participantSchema);
export function PlanningCalendar({ active }: { active: boolean }) {
  const t = useTranslations('planning'); const locale = useLocale();
  const [anchor, setAnchor] = useState(() => calendarDay(new Date().toISOString())); const [mode, setMode] = useState<CalendarMode>(DEFAULT_CALENDAR_MODE);
  const [personId, setPersonId] = useState(''); const [kind, setKind] = useState('all'); const [status, setStatus] = useState('active');
  const [revision, setRevision] = useState(0); const [editing, setEditing] = useState<{ base: PlanningCalendarEntry | null } | null>(null);
  const period = calendarPeriodRange(calendarPeriodDays(anchor, mode));
  const query = new URLSearchParams({ startsAt: period.from, endsAt: period.to, kind, status, ...(personId ? { personId } : {}) }).toString();
  const read = usePlanningRead(`/planning/calendar?${query}`, planningCalendarSchema, active, revision);
  const people = usePlanningRead('/participants', peopleSchema, active, revision);
  function refresh() { setRevision((value) => value + 1); }
  return <>
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><p className="max-w-3xl text-sm text-muted-foreground">{t('calendarHelp')}</p><Button disabled={!people.ready} onClick={() => setEditing({ base: null })}>{t('add')}</Button></div>
    <CalendarControls anchor={anchor} mode={mode} onAnchorChange={setAnchor} onModeChange={setMode} onRefresh={refresh} refreshing={read.loading || people.loading} idPrefix="planning-calendar" refreshLabel={t('refresh')} />
    <div className="grid gap-x-4 sm:grid-cols-3"><Field label={t('participant')}><Combobox value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">{t('allParticipants')}</option>{people.data?.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</Combobox></Field><Field label={t('type')}><Combobox value={kind} onChange={(event) => setKind(event.target.value)}>{(['all', 'shift', 'break', 'absence'] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</Combobox></Field><Field label={t('status')}><Combobox value={status} onChange={(event) => setStatus(event.target.value)}>{(['active', 'archived', 'all'] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</Combobox></Field></div>
    <PlanningReadState data={read.data !== null} failure={read.failure ?? people.failure} loading={read.loading || people.loading} retry={refresh} />
    {read.data ? <DataTable caption={t('calendar')} resetKey={query} header={<tr><th>{t('participant')}</th><th>{t('type')}</th><th>{t('startsAt')}</th><th>{t('endsAt')}</th><th>{t('source')}</th><th>{t('status')}</th><th><span className="sr-only">{t('edit')}</span></th></tr>}
      rows={read.data.entries.map((entry) => <tr key={entry.id}><th scope="row" className="text-sm font-medium normal-case">{entry.personName}</th><td><span className={`badge ${entry.kind === 'shift' ? 'info' : 'warning'}`}>{t(entry.kind)}</span></td><td className="text-xs">{formatDateTime(entry.startsAt, locale)}</td><td className="text-xs">{formatDateTime(entry.endsAt, locale)}</td><td className="max-w-64 whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.sourceReference}<span className="cell-sub">{entry.note}</span></td><td>{t(entry.archived ? 'archived' : 'active')}</td><td><Button variant="outline" size="sm" disabled={!read.ready} onClick={() => setEditing({ base: entry })}>{t('edit')}</Button></td></tr>)} emptyRow={<tr><td colSpan={7}><Empty title={t('noResults')} /></td></tr>} /> : null}
    {editing && active ? <CalendarEntryEditor key={editing.base?.id ?? 'new'} initial={editing.base} initialPerson={personId} people={people.data ?? []} revision={revision} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} /> : null}
  </>;
}

function CalendarEntryEditor({ initial, initialPerson, people, revision, onClose, onSaved }: { initial: PlanningCalendarEntry | null; initialPerson: string; people: readonly Participant[]; revision: number; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('planning'); const [base, setBase] = useState(initial); const command = usePlanningCommand();
  const read = usePlanningRead(initial ? `/planning/calendar/${initial.id}` : null, planningCalendarDetailSchema, true, revision);
  const latest = read.data?.entry ?? base;
  return <PlanningEditor title={base?.personName ?? t('calendar')} onClose={onClose} refresh={initial ? read.refresh : undefined} loading={read.loading}>
    <PlanningReadState data={base !== null} failure={read.failure} loading={read.loading} retry={read.refresh} />
    <ActionForm dataVersion={latest?.version} onResetDraft={() => setBase(latest)} submitDisabled={initial !== null && !read.ready} submitLabel={t('save')} successMessage={t('saved')} onSubmit={async (data) => {
      const fields = planningCalendarFieldsSchema.parse({ personId: base?.personId ?? textField(data, 'personId'), kind: textField(data, 'kind'),
        startsAt: parseBookingInstant(textField(data, 'startsAt')), endsAt: parseBookingInstant(textField(data, 'endsAt')), timeZone: 'Europe/Rome',
        sourceReference: textField(data, 'sourceReference'), note: textField(data, 'note') });
      const saved = await command(base ? `/planning/calendar/${base.id}` : '/planning/calendar', planningCalendarDetailSchema,
        { ...fields, reason: textField(data, 'reason'), ...(base ? { version: base.version, archived: data.get('archived') === 'on' } : {}) }, base ? 'PATCH' : 'POST');
      onSaved(); return saved.entry.version;
    }}>
      <Field label={t('participant')}><Combobox name="personId" required disabled={base !== null} defaultValue={base?.personId ?? initialPerson}><option value="">{t('chooseParticipant')}</option>{base && !people.some((person) => person.id === base.personId) ? <option value={base.personId}>{base.personName}</option> : null}{people.filter((person) => person.enabled || person.id === base?.personId).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</Combobox></Field>
      <Field label={t('type')}><Combobox name="kind" defaultValue={base?.kind ?? 'shift'}>{planningCalendarKindSchema.options.map((value) => <option key={value} value={value}>{t(value)}</option>)}</Combobox></Field>
      <DateTimeFields startsAt={base?.startsAt} endsAt={base?.endsAt} startsAtLabel={t('startsAt')} endsAtLabel={t('endsAt')} />
      <Field label={t('source')}><textarea name="sourceReference" rows={2} required maxLength={2000} defaultValue={base?.sourceReference ?? ''} /></Field><Field label={t('note')}><textarea name="note" rows={2} maxLength={2000} defaultValue={base?.note ?? ''} /></Field>
      {base ? <><label className="checkbox-label"><Input name="archived" type="checkbox" defaultChecked={base.archived} />{t('archive')}</label><p className="text-xs text-muted-foreground">{t('archiveHelp')}</p></> : null}<PlanningReason />
    </ActionForm>
    {read.data ? <PlanningHistory entries={read.data.history.map((event) => ({ ...event, snapshot: <CalendarEntrySnapshot item={event.entry} /> }))} /> : null}
  </PlanningEditor>;
}
function CalendarEntrySnapshot({ item }: { item: PlanningCalendarEntry }) {
  const t = useTranslations('planning'); const locale = useLocale();
  return <div className="grid gap-1 whitespace-pre-wrap [overflow-wrap:anywhere]"><p className="font-medium">{item.personName} · {t(item.kind)} · {t(item.archived ? 'archived' : 'active')}</p><p>{formatDateTime(item.startsAt, locale)} → {formatDateTime(item.endsAt, locale)}</p><p>{t('source')}: {item.sourceReference}</p><p>{item.note}</p></div>;
}
