'use client';

import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { apiRequest, errorMessage, mutate } from '@/lib/api';
import { appointmentParticipantsSchema, detailSchema, skillSchema, type Appointment, type AvailableParticipant, type DeliveryDetail, type Skill, type SkillSnapshot } from '@/lib/contracts';
import { replaceStaffSelection, staffingAvailabilityProblems, staffingSelectionProblems, staffingSkillProblems, type CrewStaffSelection } from '@/lib/staffing';
import { assignmentSkillRequirements } from '@/lib/skills';
import { matchesParticipantChoiceFilter, participantChoiceStates, type ParticipantChoiceFilter, type ParticipantChoiceState } from '@/lib/participant-choice-filters';
import { formatDateTime } from '@/lib/time';
import { ActionForm, ChoiceGroup, Field, Notice, Pending, textField } from './ui';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { RecordedSkillBadges } from './skill-choices';

export function useVisitAvailability(deliveryId: string, appointment: Pick<Appointment, 'id' | 'startsAt' | 'endsAt'>, refreshKey = 0) {
  const locale = useLocale();
  const [people, setPeople] = useState<AvailableParticipant[] | null>(null);
  const [failureState, setFailureState] = useState<{ cause: unknown } | null>(null);
  const error = failureState ? errorMessage(failureState.cause, locale) : null;
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<string | null>(null);
  const requestKey = `${deliveryId}/${appointment.id}/${appointment.startsAt}/${appointment.endsAt}/${refreshKey}/${revision}`;
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest(`/deliveries/${deliveryId}/appointments/${appointment.id}/participants`, appointmentParticipantsSchema, { signal: controller.signal }).then(
      (value) => { if (!controller.signal.aborted) { setPeople(value.people); setFailureState(null); setSettled(requestKey); } },
      (failure: unknown) => { if (!controller.signal.aborted) { setFailureState({ cause: failure }); setSettled(requestKey); } },
    );
    return () => controller.abort();
  }, [deliveryId, appointment.id, requestKey]);
  return { people, error, loading: settled !== requestKey, refresh: () => setRevision((value) => value + 1) };
}

export function ParticipantChoices({ label, people, selectedIds, onChange, duplicates = [], assignedElsewhereIds = [], retainedIds = [], requiredSkills = [], skills = [] }: { label: string; people: AvailableParticipant[]; selectedIds: string[]; onChange: (id: string, selected: boolean) => void; duplicates?: string[]; assignedElsewhereIds?: string[]; retainedIds?: string[]; requiredSkills?: readonly SkillSnapshot[]; skills?: readonly Skill[] }) {
  const t = useTranslations('directory');
  const locale = useLocale();
  const groupId = useId();
  const [filter, setFilter] = useState<ParticipantChoiceFilter>('available');
  const choices = participantChoiceStates(people, { selectedIds, assignedElsewhereIds, retainedIds, requiredSkills, skills });
  const matching = choices.filter((choice) => matchesParticipantChoiceFilter(choice, filter));
  const selectedOutside = choices.filter((choice) => choice.selected && !matchesParticipantChoiceFilter(choice, filter));
  const filterOptions = [
    { value: 'all', label: t('participantFilterAll') },
    { value: 'available', label: t('participantFilterAvailable') },
    { value: 'busy', label: t('participantFilterBusy') },
    { value: 'missingSkills', label: t('participantFilterMissingSkills') },
    { value: 'selected', label: t('participantFilterSelected') },
  ] satisfies { value: ParticipantChoiceFilter; label: string }[];
  function renderChoice({ person, selected, disabled, assignedElsewhere, missingSkills, unavailableSkills }: ParticipantChoiceState, outsideFilter: boolean) {
    const skillReason = [missingSkills.length ? t('missingSkills', { skills: missingSkills.map((skill) => skill.name).join(', ') }) : '', unavailableSkills.length ? t('requiredSkillsUnavailable', { skills: unavailableSkills.map((skill) => skill.name).join(', ') }) : ''].filter(Boolean).join('. ');
    const duplicate = duplicates.includes(person.id) && selected;
    const reasonId = `${groupId}-${person.id}-reasons`;
    const hasReason = !person.enabled || person.busy || assignedElsewhere || Boolean(skillReason) || duplicate;
    return <label data-selected-outside-filter={outsideFilter || undefined} className={`checkbox-label items-start ${disabled ? 'text-muted-foreground opacity-65' : ''}`}>
      <Input data-participant-id={person.id} aria-label={person.name} aria-describedby={hasReason ? reasonId : undefined} type="checkbox" checked={selected} disabled={disabled} onChange={(event) => onChange(person.id, event.target.checked)} />
      <span className="min-w-0 flex-1">{person.name}{person.external ? <span className="badge neutral ml-2">{t('external')}</span> : null}
        {hasReason ? <span id={reasonId}>
          {!person.enabled ? <span className="cell-sub">{t(selected ? 'participantDisabledSelected' : 'disabledNewStaffing')}</span> : null}
          {person.busy ? <span className="cell-sub">{t('busyConflict', { conflicts: person.conflicts.map((conflict) => `${conflict.pickingName} · ${formatDateTime(conflict.startsAt, locale)} → ${formatDateTime(conflict.endsAt, locale)}`).join('; ') || t('overlappingAppointment') })}</span> : null}
          {assignedElsewhere ? <span className="cell-sub">{t('alreadyAnotherCrew')}</span> : null}
          {skillReason ? <span className="cell-sub text-destructive">{skillReason}</span> : null}
          {duplicate ? <span className="cell-sub text-destructive">{t('selectedAnotherCrew')}</span> : null}
        </span> : null}
      </span>
    </label>;
  }
  return <ChoiceGroup label={label}>
    <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label={t('participantFilterLabel')}>
      {filterOptions.map((option) => <Button key={option.value} type="button" size="sm" variant={filter === option.value ? 'default' : 'outline'} className="gap-1.5 px-2.5 motion-reduce:transition-none" data-participant-filter={option.value} aria-pressed={filter === option.value} aria-controls={`${groupId}-choices`} onClick={() => setFilter(option.value)}>
        {option.label}<span className="rounded bg-current/10 px-1.5 text-[10px] tabular-nums">{choices.filter((choice) => matchesParticipantChoiceFilter(choice, option.value)).length}</span>
      </Button>)}
    </div>
    <p className="mb-2 text-[11px] text-muted-foreground" role="status">{t('participantFilterSummary', { shown: matching.length, total: choices.length, selected: choices.filter((choice) => choice.selected).length })}</p>
    <div id={`${groupId}-choices`} className="choice-list">
      {matching.length === 0 ? <p className="small muted py-3">{t(people.length === 0 ? 'noParticipantProfiles' : 'participantFilterNoMatch')}</p> : null}
      {[...matching, ...selectedOutside].map((choice, index) => <Fragment key={choice.person.id}>
        {selectedOutside.length > 0 && index === matching.length ? <p className="mt-2 border-t border-border px-2 pt-2 text-[11px] font-medium text-info-foreground">{t('participantFilterSelectedOutside')}</p> : null}
        {renderChoice(choice, index >= matching.length)}
      </Fragment>)}
    </div>
  </ChoiceGroup>;
}

export function duplicateStaffIds(rows: readonly CrewStaffSelection[]): string[] {
  const seen = new Set<string>(); const duplicates = new Set<string>();
  for (const row of rows) for (const id of row.participantIds) { if (seen.has(id)) duplicates.add(id); seen.add(id); }
  return [...duplicates];
}

function fromAppointment(appointment: Appointment): CrewStaffSelection[] {
  return appointment.assignments.map((assignment) => ({ id: assignment.id, crewName: assignment.crewName, participantIds: assignment.people.map((person) => person.id) }));
}

export function StaffingEditor({ deliveryId, appointmentId, onClose, onChanged }: { deliveryId: string; appointmentId: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations('directory');
  const locale = useLocale();
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<number | null>(null);
  const [failureState, setFailureState] = useState<{ cause: unknown } | null>(null);
  const error = failureState ? errorMessage(failureState.cause, locale) : null;
  const [saving, setSaving] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const loading = revision !== settled;
  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller;
    void Promise.all([apiRequest(`/deliveries/${deliveryId}`, detailSchema, { signal: controller.signal }), apiRequest('/skills', z.array(skillSchema), { signal: controller.signal })]).then(
      ([value, nextSkills]) => { if (!controller.signal.aborted) { setDetail(value); setSkills(nextSkills); setFailureState(null); setSettled(revision); } },
      (failure: unknown) => { if (!controller.signal.aborted) { setFailureState({ cause: failure }); setSettled(revision); } },
    );
    return () => controller.abort();
  }, [deliveryId, revision]);
  const appointment = detail?.delivery.appointments.find((entry) => entry.id === appointmentId);
  async function save(version: number, rows: CrewStaffSelection[], reason: string) {
    controllerRef.current?.abort();
    setSaving(true);
    try {
      const saved = await mutate(`/deliveries/${deliveryId}/appointments/${appointmentId}/participants`, detailSchema, { version, assignments: rows.map((row) => ({ assignmentId: row.id, participantIds: row.participantIds })), reason }, 'PATCH');
      setDetail(saved); setFailureState(null); setSettled(revision); onChanged(); return saved.delivery.version;
    } finally { setSaving(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="dialog !max-w-[760px]" aria-describedby={undefined}><div className="section-title"><div><DialogTitle asChild><h2>{t('editVisitStaff')}</h2></DialogTitle><p className="small muted">{detail?.delivery.source.pickingName ?? t('loadingDelivery')}</p></div><div className="flex gap-2"><button className="button secondary small" disabled={loading || saving} onClick={() => setRevision((value) => value + 1)}>{t('refreshVisit')}</button><button className="icon-button" aria-label={t('closeStaffing')} onClick={onClose}>×</button></div></div><div className="mb-3 flex h-10 items-center text-xs" role="status">{error ? <span className="text-destructive">{error}</span> : detail && loading ? <span className="muted">{t('refreshingVisit')}</span> : null}</div>{!detail && loading ? <Pending /> : null}{detail && appointment && skills ? <StaffingForm key={appointmentId} detail={detail} appointment={appointment} skills={skills} refreshKey={revision} loadingVisit={loading} onSave={save} /> : detail ? <Notice tone="error">{t('appointmentMissing')}</Notice> : null}</DialogContent></Dialog>;
}

function StaffingForm({ detail, appointment, skills, refreshKey, loadingVisit, onSave }: { detail: DeliveryDetail; appointment: Appointment; skills: Skill[]; refreshKey: number; loadingVisit: boolean; onSave: (version: number, rows: CrewStaffSelection[], reason: string) => Promise<number> }) {
  const t = useTranslations('directory');
  const locale = useLocale();
  const [rows, setRows] = useState(() => fromAppointment(appointment));
  const availability = useVisitAvailability(detail.delivery.id, appointment, refreshKey);
  const requirements = new Map(appointment.assignments.map((assignment) => [assignment.id, assignmentSkillRequirements(assignment)]));
  const problems = [...staffingSelectionProblems(rows, t), ...(availability.people ? [...staffingAvailabilityProblems(rows, availability.people, fromAppointment(appointment), t), ...staffingSkillProblems(rows, availability.people, requirements, skills, t)] : [])];
  const blocked = detail.delivery.completedAt !== null || appointment.status !== 'booked' || appointment.results.length > 0;
  return <><p className="visit-time">{formatDateTime(appointment.startsAt, locale)} → {formatDateTime(appointment.endsAt, locale)}</p><p className="small muted">{t('staffingEditorIntro')}</p><div className="my-3 flex min-h-8 items-center justify-between gap-3 text-xs" role="status"><span className={availability.error ? 'text-destructive' : 'text-muted-foreground'}>{availability.error ?? (availability.loading ? t('checkingAvailability') : t('availabilityChecked'))}</span><button className="text-button" disabled={availability.loading} onClick={availability.refresh}>{t('refreshAvailability')}</button></div>{blocked ? <Notice>{t('staffingBlocked')}</Notice> : null}<ActionForm dataVersion={detail.delivery.version} onResetDraft={() => setRows(fromAppointment(appointment))} disabled={blocked || availability.people === null} submitDisabled={loadingVisit || availability.loading || availability.error !== null || problems.length > 0} submitLabel={t('saveVisitStaff')} onSubmit={async (data) => {
    const currentProblems = staffingSelectionProblems(rows, t); if (currentProblems.length) throw new Error(currentProblems.join(' '));
    const savedVersion = await onSave(detail.delivery.version, rows, textField(data, 'reason')); availability.refresh(); return savedVersion;
  }}>{rows.map((row) => <section key={row.id} className="my-4 rounded-lg border border-border p-4"><h3>{row.crewName}</h3><RecordedSkillBadges skills={requirements.get(row.id)} />{availability.people ? <ParticipantChoices label={t('staffFor', { crew: row.crewName })} people={availability.people} skills={skills} requiredSkills={requirements.get(row.id) ?? []} selectedIds={row.participantIds} retainedIds={appointment.assignments.find((assignment) => assignment.id === row.id)?.people.map((person) => person.id) ?? []} duplicates={duplicateStaffIds(rows)} onChange={(id, selected) => setRows((current) => replaceStaffSelection(current, row.id, id, selected))} /> : <Pending>{t('loadingParticipants')}</Pending>}</section>)}{problems.length ? <Notice>{problems.join(' ')}</Notice> : null}<Field label={t('staffingReason')}><Input name="reason" required maxLength={2000} /></Field></ActionForm></>;
}




