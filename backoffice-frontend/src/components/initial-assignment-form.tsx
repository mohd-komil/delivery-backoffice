'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { z } from 'zod';
import type { Appointment, Crew, Skill, TaskTemplate } from '@/lib/contracts';
import { replaceStaffSelection, staffingAvailabilityProblems, staffingSelectionProblems, staffingSkillProblems, type CrewStaffSelection } from '@/lib/staffing';
import { mergeSkillRequirements, skillReferences } from '@/lib/skills';
import { ActionForm, ChoiceGroup, Notice } from './ui';
import { Input } from './ui/input';
import { duplicateStaffIds, ParticipantChoices, useVisitAvailability } from './staffing-editor';
import { SkillBadges } from './skill-choices';
import { deliveryStatusLabel } from './delivery-detail-presentation';

type AssignCommand = (path: string, body: unknown) => Promise<number>;

export function InitialAssignmentForm({ deliveryId, version, appointment, crews, templates, skills = [], refreshKey = 0, command, onAssigned }: { deliveryId: string; version: number; appointment: Appointment; crews: Crew[]; templates: TaskTemplate[]; skills?: Skill[]; refreshKey?: number; command: AssignCommand; onAssigned?: () => void }) {
  const t = useTranslations('delivery');
  const staffText = useTranslations('directory');
  const [rows, setRows] = useState<CrewStaffSelection[]>([]);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [templateIds, setTemplateIds] = useState<string[]>([]);
  const availability = useVisitAvailability(deliveryId, appointment, refreshKey);
  const existingRows = appointment.assignments.map((assignment) => ({ id: assignment.id, crewName: assignment.crewName, participantIds: assignment.people.map((person) => person.id) }));
  const selectedTemplates = templates.filter((template) => templateIds.includes(template.id));
  const requiredSkills = mergeSkillRequirements(selectedTemplates.flatMap((template) => skillReferences(template.requiredSkillIds, skills, staffText)));
  const requirements = new Map(rows.map((row) => [row.id, requiredSkills]));
  const problems = [...staffingSelectionProblems([...existingRows, ...rows], staffText), ...selectedTemplates.filter((template) => !template.enabled).map((template) => t('templateDisabled', { template: template.title })), ...(templateIds.some((id) => !templates.some((template) => template.id === id)) ? [t('templateUnavailable')] : []), ...(availability.people ? [...staffingAvailabilityProblems(rows, availability.people, [], staffText), ...staffingSkillProblems(rows, availability.people, requirements, skills, staffText)] : [])];
  const existingPeople = existingRows.flatMap((row) => row.participantIds);
  function chooseCrew(crew: Crew, selected: boolean) {
    setRows((current) => selected ? [...current, { id: crew.id, crewName: crew.name, participantIds: crew.people.map((person) => person.id) }] : current.filter((row) => row.id !== crew.id));
  }
  return <ActionForm dataVersion={version} onResetDraft={() => { setRows([]); setTemplateIds([]); setRequestId(crypto.randomUUID()); }} submitLabel={t('assignCrews')} submitDisabled={availability.loading || availability.error !== null || availability.people === null || rows.length === 0 || templateIds.length === 0 || problems.length > 0} onSubmit={async () => {
    const selectedTemplateIds = z.array(z.uuid()).min(1, t('selectTemplate')).parse(templateIds);
    const savedVersion = await command(`/appointments/${appointment.id}/assign`, { version, requestId, crewIds: rows.map((row) => row.id), templateIds: selectedTemplateIds, staffing: rows.map((row) => ({ crewId: row.id, participantIds: row.participantIds })) });
    setRows([]); setTemplateIds([]); setRequestId(crypto.randomUUID()); availability.refresh();
    onAssigned?.();
    return savedVersion;
  }}>
    <ChoiceGroup label={t('crews')}><div className="choice-list">{crews.map((crew) => <label key={crew.id} className="checkbox-label"><Input type="checkbox" name="crewIds" value={crew.id} checked={rows.some((row) => row.id === crew.id)} onChange={(event) => chooseCrew(crew, event.target.checked)} disabled={!crew.enabled || appointment.assignments.some((assignment) => assignment.crewId === crew.id)} />{crew.name}<span className="muted small">{deliveryStatusLabel(t, crew.classification)} · {crew.area}{!crew.enabled ? ` · ${deliveryStatusLabel(t, 'disabled')}` : ''}</span></label>)}</div></ChoiceGroup>
    <ChoiceGroup label={t('templatesForCrews')}><div className="choice-list">{templates.map((template) => <label key={template.id} className="checkbox-label"><Input name="templateIds" type="checkbox" value={template.id} checked={templateIds.includes(template.id)} disabled={!template.enabled && !templateIds.includes(template.id)} onChange={(event) => setTemplateIds((current) => event.target.checked ? [...current, template.id] : current.filter((id) => id !== template.id))} /><span>{template.title}<span className="cell-sub">{t('taskOrder', { severity: deliveryStatusLabel(t, template.severity), order: template.order })}{!template.enabled ? ` · ${t('disabledNewAssignments')}` : ''}</span></span></label>)}{templateIds.filter((id) => !templates.some((template) => template.id === id)).map((id) => <button key={id} className="text-button" type="button" onClick={() => setTemplateIds((current) => current.filter((entry) => entry !== id))}>{t('removeTemplate', { id: id.slice(0, 8) })}</button>)}</div></ChoiceGroup>
    <p className="small muted">{t('assignmentSkillsHint')}</p><SkillBadges ids={requiredSkills.map((skill) => skill.id)} skills={skills} />
    <div className="my-3 flex min-h-8 items-center justify-between gap-3 text-xs" role="status"><span className={availability.error ? 'text-destructive' : 'text-muted-foreground'}>{availability.error ?? (availability.loading ? t('checkingVisitAvailability') : t('visitAvailabilityChecked'))}</span><button className="text-button" type="button" disabled={availability.loading} onClick={availability.refresh}>{t('refreshAvailability')}</button></div>
    <p className="small muted">{t('rosterHint')}</p>
    {rows.map((row) => <section key={row.id} className="my-4 rounded-lg border border-border p-4"><h4>{t('actualParticipants', { crew: row.crewName })}</h4>{availability.people ? <ParticipantChoices label={t('staffFor', { crew: row.crewName })} people={availability.people} skills={skills} requiredSkills={requiredSkills} selectedIds={row.participantIds} assignedElsewhereIds={existingPeople} duplicates={duplicateStaffIds([...existingRows, ...rows])} onChange={(id, selected) => setRows((current) => replaceStaffSelection(current, row.id, id, selected))} /> : null}</section>)}
    {rows.length > 0 && problems.length ? <Notice>{problems.join(' ')}</Notice> : null}
    <p className="small muted">{t('assignmentFiltersHint')}</p>
  </ActionForm>;
}
