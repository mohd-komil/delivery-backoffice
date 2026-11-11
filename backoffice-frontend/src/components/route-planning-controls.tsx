'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { Crew, Participant } from '@/lib/contracts';
import type { RoutePlanning, RoutePreview, RouteWindow } from '@/lib/route-drafts';
import { formatDateTime } from '@/lib/time';
import { DateTimeInput } from './date-time-fields';
import { Field } from './ui';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';

export const emptyRoutePlanning: RoutePlanning = { participantIds: [], participantAvailability: [], vehicleAvailability: null, driver: { kind: 'unknown' }, transferBufferMinutes: null };
type Interval = { startsAt: string; endsAt: string };

function IntervalFields({ interval, onChange, label }: { interval: Interval; onChange: (next: Interval) => void; label: string }) {
  const t = useTranslations('routeChecks');
  return <div className="grid gap-2 sm:grid-cols-2">
    <DateTimeInput name={`${label}-start`} label={`${label} · ${t('start')}`} initialInstant={interval.startsAt || undefined} onInstantChange={(startsAt) => onChange({ ...interval, startsAt })} />
    <DateTimeInput name={`${label}-end`} label={`${label} · ${t('end')}`} initialInstant={interval.endsAt || undefined} onInstantChange={(endsAt) => onChange({ ...interval, endsAt })} />
  </div>;
}

export function RouteWindowFields({ value, onChange, initialWindow }: { value?: RouteWindow; onChange: (next: RouteWindow) => void; initialWindow?: Interval }) {
  const t = useTranslations('routeChecks');
  return <div className="grid gap-2 rounded-md border border-border bg-muted/20 p-3">
    <Field label={t('window')}><select value={value?.kind ?? 'unknown'} onChange={(event) => {
      const kind = event.target.value;
      if (kind === 'arrival' || kind === 'work_end') onChange({ ...((value?.kind === 'arrival' || value?.kind === 'work_end') ? value : initialWindow ?? { startsAt: '', endsAt: '' }), kind });
      else if (kind === 'unrestricted' || kind === 'unknown') onChange({ kind });
    }}>{(['unknown', 'unrestricted', 'arrival', 'work_end'] as const).map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}</select></Field>
    {value?.kind === 'arrival' || value?.kind === 'work_end' ? <IntervalFields interval={value} label={t('window')} onChange={(next) => onChange({ ...next, kind: value.kind })} /> : null}
  </div>;
}

export function RouteResourceFields({ value, onChange, participants, crew }: {
  value: RoutePlanning; onChange: (next: RoutePlanning) => void; participants: readonly Participant[]; crew?: Crew;
}) {
  const t = useTranslations('routeChecks');
  function selectPeople(participantIds: string[]) {
    onChange({ ...value, participantIds, participantAvailability: value.participantAvailability.filter((entry) => participantIds.includes(entry.participantId)),
      driver: value.driver.kind === 'participant' && !participantIds.includes(value.driver.participantId) ? { kind: 'unknown' } : value.driver });
  }
  function availability(participantId: string, next: RoutePlanning['participantAvailability'][number]) {
    onChange({ ...value, participantAvailability: [...value.participantAvailability.filter((entry) => entry.participantId !== participantId), next] });
  }
  const driver = value.driver;
  return <Card className="grid gap-4 p-4 sm:p-5"><h2 className="text-base font-semibold">{t('resources')}</h2><p className="text-xs text-muted-foreground">{t('help')}</p>
    <fieldset className="grid gap-2"><legend className="mb-2 text-sm font-medium">{t('participants')}</legend>
      {crew ? <Button className="justify-self-start" type="button" variant="outline" size="sm" onClick={() => selectPeople(crew.people.filter((person) => participants.some((entry) => entry.id === person.id && entry.enabled)).map((person) => person.id))}>{t('roster')}</Button> : null}
      <div className="grid max-h-48 gap-2 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">{participants.filter((person) => person.enabled || value.participantIds.includes(person.id)).map((person) => <label key={person.id} className="flex items-center gap-2 text-sm"><Input type="checkbox" checked={value.participantIds.includes(person.id)} disabled={!person.enabled && !value.participantIds.includes(person.id)} onChange={(event) => selectPeople(event.target.checked ? [...value.participantIds, person.id] : value.participantIds.filter((id) => id !== person.id))} />{person.name}</label>)}</div>
    </fieldset>
    {value.participantIds.map((participantId) => {
      const entry = value.participantAvailability.find((item) => item.participantId === participantId) ?? { participantId, workingIntervals: [], unavailableIntervals: [] };
      const name = participants.find((person) => person.id === participantId)?.name ?? participantId;
      return <details key={participantId} className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">{name} · {t('hours')}</summary><div className="mt-3 grid gap-3">
        {entry.workingIntervals.map((interval, index) => <IntervalFields key={`${participantId}-work-${index}`} interval={interval} label={`${name} ${t('hours')} ${index + 1}`} onChange={(next) => availability(participantId, { ...entry, workingIntervals: entry.workingIntervals.map((current, i) => i === index ? next : current) })} />)}
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={entry.workingIntervals.length >= 30} onClick={() => availability(participantId, { ...entry, workingIntervals: [...entry.workingIntervals, { startsAt: '', endsAt: '' }] })}>{t('add')}</Button>{entry.workingIntervals.length ? <Button type="button" variant="ghost" size="sm" onClick={() => availability(participantId, { ...entry, workingIntervals: entry.workingIntervals.slice(0, -1) })}>{t('remove')}</Button> : null}</div>
        <h3 className="text-sm font-medium">{t('breaks')}</h3>
        {entry.unavailableIntervals.map((interval, index) => <div key={`${participantId}-break-${index}`} className="grid gap-2 rounded-md bg-muted/30 p-2"><Field label={t('breaks')}><select value={interval.kind} onChange={(event) => { const kind = event.target.value; if (kind === 'break' || kind === 'absence') availability(participantId, { ...entry, unavailableIntervals: entry.unavailableIntervals.map((current, i) => i === index ? { ...current, kind } : current) }); }}><option value="break">{t('break')}</option><option value="absence">{t('absence')}</option></select></Field><IntervalFields interval={interval} label={`${name} ${t(interval.kind)} ${index + 1}`} onChange={(next) => availability(participantId, { ...entry, unavailableIntervals: entry.unavailableIntervals.map((current, i) => i === index ? { ...next, kind: current.kind } : current) })} /></div>)}
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={entry.unavailableIntervals.length >= 60} onClick={() => availability(participantId, { ...entry, unavailableIntervals: [...entry.unavailableIntervals, { startsAt: '', endsAt: '', kind: 'break' }] })}>{t('add')}</Button>{entry.unavailableIntervals.length ? <Button type="button" variant="ghost" size="sm" onClick={() => availability(participantId, { ...entry, unavailableIntervals: entry.unavailableIntervals.slice(0, -1) })}>{t('remove')}</Button> : null}</div>
      </div></details>;
    })}
    <Field label={t('driver')}><select value={driver.kind === 'participant' ? driver.participantId : driver.kind} onChange={(event) => {
      const selected = event.target.value;
      onChange({ ...value, driver: selected === 'unknown' ? { kind: 'unknown' } : selected === 'external' ? { kind: 'external', name: '', availability: null } : { kind: 'participant', participantId: selected } });
    }}><option value="unknown">{t('unknown')}</option><option value="external">{t('external')}</option>{value.participantIds.map((id) => <option key={id} value={id}>{participants.find((person) => person.id === id)?.name ?? id}</option>)}</select></Field>
    {driver.kind === 'external' ? <><Field label={t('driverName')}><Input required maxLength={200} value={driver.name} onChange={(event) => onChange({ ...value, driver: { ...driver, name: event.target.value } })} /></Field><OptionalInterval label={t('driverHours')} value={driver.availability} onChange={(availability) => onChange({ ...value, driver: { ...driver, availability } })} /></> : null}
    <OptionalInterval label={t('vehicleHours')} value={value.vehicleAvailability} onChange={(vehicleAvailability) => onChange({ ...value, vehicleAvailability })} />
    <Field label={t('buffer')} hint={t('bufferHelp')}><Input type="number" min={0} max={240} step={1} value={value.transferBufferMinutes ?? ''} onChange={(event) => onChange({ ...value, transferBufferMinutes: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
  </Card>;
}

function OptionalInterval({ label, value, onChange }: { label: string; value: Interval | null; onChange: (next: Interval | null) => void }) {
  const t = useTranslations('routeChecks');
  return <section className="grid gap-2 rounded-md border p-3"><label className="flex items-center gap-2 text-sm font-medium"><Input type="checkbox" checked={value !== null} onChange={(event) => onChange(event.target.checked ? { startsAt: '', endsAt: '' } : null)} />{label}</label>{value ? <IntervalFields interval={value} label={label} onChange={onChange} /> : <p className="text-xs text-muted-foreground">{t('unknown')}</p>}</section>;
}

export function RouteFeasibility({ preview, stale, pointName }: { preview?: RoutePreview; stale: boolean; pointName: (id: string) => string }) {
  const t = useTranslations('routeChecks');
  const locale = useLocale();
  const check = preview?.feasibility;
  return <Card className="grid gap-3 p-4 sm:p-5"><h2 className="text-base font-semibold">{t('title')}</h2>
    <p className={`badge ${stale || !check || check.status === 'insufficient_data' ? 'warning' : check.status === 'conflict' ? 'danger' : 'success'}`} role="status">{stale && check ? t('stale') : t(check?.status ?? 'insufficient_data')}</p>
    {check ? <><p className="text-xs text-muted-foreground">{t('checked', { date: formatDateTime(check.checkedAt, locale) })}</p><ul className="grid gap-2">{check.findings.map((finding, index) => <li key={`${finding.code}-${index}`} className={`rounded-md border p-3 text-xs ${finding.severity === 'conflict' ? 'border-destructive/30 bg-destructive/5' : 'border-warning-foreground/25 bg-warning'}`}>
      {finding.deliveryId ? <strong className="mb-1 block">{pointName(finding.deliveryId)}</strong> : null}<p>{finding.message}</p>{finding.startsAt && finding.endsAt ? <p className="mt-1 font-mono">{formatDateTime(finding.startsAt, locale)} → {formatDateTime(finding.endsAt, locale)}</p> : null}
    </li>)}</ul></> : null}
    <p className="text-xs text-muted-foreground">{t('estimated')}</p>
  </Card>;
}
