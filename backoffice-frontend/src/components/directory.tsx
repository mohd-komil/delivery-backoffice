'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { ParticipantForm } from './participant-form';
import { z } from 'zod';
import { Input } from './ui/input';
import { crewSchema, participantSchema, skillSchema, templateSchema, type Crew, type Participant, type Skill, type TaskTemplate, type User } from '@/lib/contracts';
import { skillSelectionProblems } from '@/lib/skills';
import { SkillBadges, SkillChoices } from './skill-choices';
import { apiRequest, errorMessage, mutate } from '@/lib/api';
import { ActionForm, ChoiceGroup, Empty, Field, Notice, Pending, textField } from './ui';
import { PageHeadingTitle } from './page-help';
import { DirectoryDeleteDialog, DirectoryRecordView, type DirectoryRecord } from './directory-record-dialogs';
import { DataTable } from './ui/data-table';

export function Directory({ user, initialTab = 'crews' }: { user: User; initialTab?: 'crews' | 'templates' | 'participants' }) {
  const t = useTranslations('directory');
  const locale = useLocale();
  const [crews, setCrews] = useState<Crew[] | null>(null);
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [templates, setTemplates] = useState<TaskTemplate[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [failureState, setFailureState] = useState<{ cause: unknown } | null>(null);
  const error = failureState ? errorMessage(failureState.cause, locale) : null;
  const [revision, setRevision] = useState(0);
  const [settledRevision, setSettledRevision] = useState<number | null>(null);
  const [tab, setTab] = useState<'crews' | 'templates' | 'participants'>(initialTab);
  const [editingCrew, setEditingCrew] = useState<string | 'new' | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<string | 'new' | null>(null);
  const [editingParticipant, setEditingParticipant] = useState<string | null>(null);
  const [participantDraftBase, setParticipantDraftBase] = useState<Participant | undefined>(undefined);
  const [crewDraftBase, setCrewDraftBase] = useState<Crew | undefined>(undefined);
  const [templateDraftBase, setTemplateDraftBase] = useState<TaskTemplate | undefined>(undefined);
  const [area, setArea] = useState('');
  const [classification, setClassification] = useState('all');
  const [viewing, setViewing] = useState<DirectoryRecord | null>(null);
  const [deleting, setDeleting] = useState<DirectoryRecord | null>(null);
  const pendingRead = useRef<AbortController | null>(null);
  const busy = settledRevision !== revision;
  function refreshDirectory() { setRevision((value) => value + 1); }
  useEffect(() => {
    const controller = new AbortController();
    pendingRead.current = controller;
    void Promise.all([apiRequest('/crews', z.array(crewSchema), { signal: controller.signal }), apiRequest('/templates', z.array(templateSchema), { signal: controller.signal }), apiRequest('/participants', z.array(participantSchema), { signal: controller.signal }), apiRequest('/skills', z.array(skillSchema), { signal: controller.signal })]).then(
      ([nextCrews, nextTemplates, nextParticipants, nextSkills]) => { if (!controller.signal.aborted) { setCrews(nextCrews); setTemplates(nextTemplates); setParticipants(nextParticipants); setSkills(nextSkills); setFailureState(null); setSettledRevision(revision); } },
      (failure: unknown) => { if (!controller.signal.aborted) { setFailureState({ cause: failure }); setSettledRevision(revision); } },
    );
    return () => controller.abort();
  }, [revision]);
  const admin = user.role === 'admin';
  const filteredCrews = crews?.filter((crew) => crew.area.toLowerCase().includes(area.toLowerCase()) && (classification === 'all' || crew.classification === classification)) ?? [];
  const selectedCrew = crewDraftBase;
  const selectedTemplate = templateDraftBase;
  const crewChanged = selectedCrew !== undefined && crews?.find((crew) => crew.id === selectedCrew.id)?.version !== selectedCrew.version;
  const templateChanged = selectedTemplate !== undefined && templates?.find((template) => template.id === selectedTemplate.id)?.version !== selectedTemplate.version;
  function openCrew(crew: Crew | undefined) { setCrewDraftBase(crew); setEditingCrew(crew?.id ?? 'new'); }
  function openTemplate(template: TaskTemplate | undefined) { setTemplateDraftBase(template); setEditingTemplate(template?.id ?? 'new'); }
  function openParticipant(participant: Participant | undefined) { setParticipantDraftBase(participant); setEditingParticipant(participant?.id ?? 'new'); }
  function savedParticipant(saved: Participant) { setParticipants((current) => current ? [...current.filter((person) => person.id !== saved.id), saved] : [saved]); setEditingParticipant(null); refreshDirectory(); }
  const participantChanged = participantDraftBase !== undefined && participants?.find((person) => person.id === participantDraftBase.id)?.version !== participantDraftBase.version;
  function changed() { setRevision((value) => value + 1); setEditingCrew(null); setEditingTemplate(null); }
  function currentRecord(record: DirectoryRecord): DirectoryRecord | undefined {
    if (record.kind === 'participant') { const value = participants?.find((entry) => entry.id === record.value.id); return value ? { kind: 'participant', value } : undefined; }
    if (record.kind === 'crew') { const value = crews?.find((entry) => entry.id === record.value.id); return value ? { kind: 'crew', value } : undefined; }
    const value = templates?.find((entry) => entry.id === record.value.id); return value ? { kind: 'template', value } : undefined;
  }
  function editRecord(record: DirectoryRecord) { setViewing(null); if (record.kind === 'participant') openParticipant(record.value); else if (record.kind === 'crew') openCrew(record.value); else openTemplate(record.value); }
  function deletedRecord(record: DirectoryRecord) {
    pendingRead.current?.abort();
    if (record.kind === 'participant') setParticipants((current) => current?.filter((entry) => entry.id !== record.value.id) ?? null);
    else if (record.kind === 'crew') setCrews((current) => current?.filter((entry) => entry.id !== record.value.id) ?? null);
    else setTemplates((current) => current?.filter((entry) => entry.id !== record.value.id) ?? null);
    setDeleting(null); refreshDirectory();
  }
  const viewedRecord = viewing ? currentRecord(viewing) : undefined;
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('peopleEyebrow')}</p><PageHeadingTitle title={t('peopleTitle')} topic={tab} /><p className="subtitle">{t('peopleSubtitle')}</p></div><div className="flex flex-wrap items-center gap-2"><button className="button secondary" disabled={busy} onClick={refreshDirectory}>{t('refresh')}</button>{admin ? <button className="button" onClick={() => tab === 'crews' ? openCrew(undefined) : tab === 'participants' ? openParticipant(undefined) : openTemplate(undefined)}>+ {tab === 'crews' ? t('newCrew') : tab === 'participants' ? t('newParticipant') : t('newTemplate')}</button> : null}</div></div>
    {!admin ? <Notice>{t('peopleOperatorNotice')}</Notice> : null}
    <div className="mb-3 flex h-10 items-center gap-3 text-xs" aria-live="polite" role="status">
      {error && !busy ? <><span className="max-h-10 flex-1 overflow-y-auto text-destructive">{error}{crews && templates ? " " + t('previousDirectories') : ''}</span><button className="text-button" onClick={refreshDirectory}>{t('retry')}</button></> : <span className="text-muted-foreground">{busy && crews && templates ? t('refreshingDirectories') : ''}</span>}
    </div>
    <div className="tabbar"><button className={tab === 'participants' ? 'active' : ''} onClick={() => setTab('participants')}>{t('participants')} <span>{participants?.length ?? '—'}</span></button><button className={tab === 'crews' ? 'active' : ''} onClick={() => setTab('crews')}>{t('crews')} <span>{crews?.length ?? '—'}</span></button><button className={tab === 'templates' ? 'active' : ''} onClick={() => setTab('templates')}>{t('templates')} <span>{templates?.length ?? '—'}</span></button></div>
    {!crews || !templates || !participants || !skills ? busy ? <Pending /> : <Empty title={t('directoriesUnavailable')}>{t('retryDirectories')}</Empty> : tab === 'crews' ? <>
      <div className="directory-filters"><Field label={t('area')}><Input value={area} onChange={(event) => setArea(event.target.value)} placeholder={t('filterArea')} /></Field><Field label={t('classification')}><select value={classification} onChange={(event) => setClassification(event.target.value)}><option value="all">{t('allClassifications')}</option><option value="indoor">{t('indoor')}</option><option value="outdoor">{t('outdoor')}</option></select></Field></div>
      <DataTable containerClassName="table-wrap crews-table-region relative" className="crews-table min-w-[860px]" caption={t('crewCaption')} resetKey={JSON.stringify(['crews', area, classification])}
          header={<tr><th scope="col">{t('crew')}</th><th scope="col">{t('classification')}</th><th scope="col">{t('area')}</th><th scope="col">{t('participants')}</th><th scope="col">{t('status')}</th><th scope="col"><span className="sr-only">{t('manageCrew')}</span></th></tr>}
          rows={filteredCrews.map((crew) => <tr key={crew.id} className="hover:bg-muted/40">
              <th scope="row" className="bg-transparent text-xs font-medium tracking-normal text-foreground normal-case">{crew.name}</th>
              <td><span className="badge neutral capitalize">{t(crew.classification)}</span></td>
              <td className="text-muted-foreground">{crew.area}</td>
              <td><span className="text-xs font-medium tabular-nums">{t('participantCount', { count: crew.people.length })}</span><div className="mt-1 flex max-w-sm flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">{crew.people.map((person) => <span key={person.id} className="inline-flex items-center gap-1.5"><Link href={`/participants/${person.id}/calendar`} className="hover:text-foreground hover:underline">{person.name}</Link>{person.external ? <span className="badge neutral">{t('external')}</span> : null}</span>)}</div></td>
              <td><span className={crew.enabled ? 'badge success' : 'badge warning'}>{crew.enabled ? t('enabled') : t('disabledReview')}</span></td>
              <td><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" size="sm" aria-label={t('viewNamedRecord', { name: crew.name })} onClick={() => setViewing({ kind: 'crew', value: crew })}>{t('viewRecord')}</Button>{admin ? <><button className="button secondary small" aria-label={t('manageCrewNamed', { name: crew.name })} onClick={() => openCrew(crew)}>{t('manageCrew')}</button><Button variant="ghost" size="sm" className="text-destructive" aria-label={t('deleteNamedRecord', { name: crew.name })} onClick={() => setDeleting({ kind: 'crew', value: crew })}>{t('deleteRecord')}</Button></> : null}</div></td>
            </tr>)}
          emptyRow={crews.length > 0 ? <tr><td colSpan={6} className="py-10 text-center text-muted-foreground">{t('noMatchingCrews')}</td></tr> : null} />
      {crews.length === 0 ? <Empty title={t('noCrews')}>{t('createCrewBeforeVisit')}</Empty> : null}
    </> : tab === 'templates' ? <><div className="directory-grid">{templates.map((template) => <article key={template.id} className="directory-card"><div className="card-topline"><span className={`badge ${template.severity === 'high' ? 'danger' : 'neutral'}`}>{t('severityBadge', { severity: template.severity })}</span><span className="muted small">{t('orderVersion', { order: template.order, version: template.version })}</span></div><h2>{template.title}</h2><p className="small muted mt-3">{t('requiredEveryParticipant')}</p><SkillBadges ids={template.requiredSkillIds} skills={skills} /><ul className="template-checklist">{template.checklist.map((label, index) => <li key={`${label}-${index}`}><span aria-hidden="true">□</span>{label}</li>)}</ul><div className="card-topline"><span className={template.enabled ? 'badge success' : 'badge warning'}>{template.enabled ? t('enabled') : t('disabled')}</span></div><div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4"><Button variant="outline" size="sm" aria-label={t('viewNamedRecord', { name: template.title })} onClick={() => setViewing({ kind: 'template', value: template })}>{t('viewRecord')}</Button>{admin ? <><button className="text-button" onClick={() => openTemplate(template)}>{t('editTemplateArrow')}</button><Button variant="ghost" size="sm" className="text-destructive" aria-label={t('deleteNamedRecord', { name: template.title })} onClick={() => setDeleting({ kind: 'template', value: template })}>{t('deleteRecord')}</Button></> : null}</div></article>)}</div>{templates.length === 0 ? <Empty title={t('noTemplates')}>{t('createTemplateHint')}</Empty> : null}</> : <ParticipantTable participants={participants} skills={skills} admin={admin} onEdit={openParticipant} onView={(value) => setViewing({ kind: 'participant', value })} onDelete={(value) => setDeleting({ kind: 'participant', value })} />}
    {editingCrew && admin ? <Dialog open onOpenChange={(open) => { if (!open) setEditingCrew(null); }}><DialogContent className="dialog" aria-describedby={undefined}><div className="section-title"><DialogTitle asChild><h2>{selectedCrew ? t('editCrew') : t('newCrew')}</h2></DialogTitle><button className="icon-button" aria-label={t('closeCrew')} onClick={() => setEditingCrew(null)}>×</button></div><p className="muted">{t('crewSnapshot')}</p>{crewChanged ? <Notice>{t('newerCrew')}</Notice> : null}<CrewForm key={editingCrew} crew={selectedCrew} crews={crews ?? []} participants={participants ?? []} onCreateParticipant={() => openParticipant(undefined)} onChanged={changed} /></DialogContent></Dialog> : null}
    {editingTemplate && admin ? <Dialog open onOpenChange={(open) => { if (!open) setEditingTemplate(null); }}><DialogContent className="dialog" aria-describedby={undefined}><div className="section-title"><DialogTitle asChild><h2>{selectedTemplate ? t('editTemplate') : t('newTemplate')}</h2></DialogTitle><button className="icon-button" aria-label={t('closeTemplate')} onClick={() => setEditingTemplate(null)}>×</button></div><p className="muted">{t('templateSnapshot')}</p>{templateChanged ? <Notice>{t('newerTemplate')}</Notice> : null}<TemplateForm key={editingTemplate} template={selectedTemplate} skills={skills ?? []} onChanged={changed} /></DialogContent></Dialog> : null}
    {editingParticipant && admin ? <Dialog open onOpenChange={(open) => { if (!open) setEditingParticipant(null); }}><DialogContent className="dialog" aria-describedby={undefined}><div className="section-title"><DialogTitle asChild><h2>{participantDraftBase ? t('editParticipant') : t('newParticipant')}</h2></DialogTitle><button className="icon-button" aria-label={t('closeParticipant')} onClick={() => setEditingParticipant(null)}>×</button></div>{participantChanged ? <Notice>{t('newerParticipant')}</Notice> : null}<ParticipantForm key={editingParticipant} participant={participantDraftBase} skills={skills ?? []} onSaved={savedParticipant} /></DialogContent></Dialog> : null}
    {viewing ? <DirectoryRecordView record={viewedRecord ?? viewing} available={viewedRecord !== undefined} skills={skills ?? []} admin={admin} onClose={() => setViewing(null)} onEdit={() => { if (viewedRecord) editRecord(viewedRecord); }} onDelete={() => { if (viewedRecord) { setViewing(null); setDeleting(viewedRecord); } }} /> : null}
    {deleting && admin ? <DirectoryDeleteDialog key={`${deleting.kind}:${deleting.value.id}`} record={deleting} currentVersion={currentRecord(deleting)?.value.version} onClose={() => setDeleting(null)} onDeleted={deletedRecord} /> : null}
  </>;
}

function ParticipantTable({ participants, skills, admin, onEdit, onView, onDelete }: { participants: Participant[]; skills: Skill[]; admin: boolean; onEdit: (participant: Participant) => void; onView: (participant: Participant) => void; onDelete: (participant: Participant) => void }) {
  const t = useTranslations('directory');
  return <><DataTable containerClassName="table-wrap relative participants-table-region" className="participants-table min-w-[880px]" caption={t('participantCaption')} resetKey="participants" header={<tr><th scope="col">{t('participant')}</th><th scope="col">{t('skills')}</th><th scope="col">{t('contact')}</th><th scope="col">{t('address')}</th><th scope="col">{t('typeStatus')}</th>{admin ? <th scope="col">{t('futureCredentials')}</th> : null}<th scope="col"><span className="sr-only">{t('manageParticipant')}</span></th></tr>} rows={participants.map((participant) => <tr key={participant.id} className="hover:bg-muted/40"><th scope="row" className="bg-transparent text-xs font-medium tracking-normal text-foreground normal-case"><Link className="reference" href={`/participants/${participant.id}/calendar`}>{participant.name}</Link><span className="cell-sub">{t('participantNames', { first: participant.firstName ?? t('notProvided'), last: participant.lastName ?? t('notProvided') })}</span>{participant.preferredName ? <span className="cell-sub">{t('preferredParticipantName', { name: participant.preferredName })}</span> : null}</th><td><SkillBadges ids={participant.skillIds} skills={skills} /></td><td>{participant.phoneNumber ?? <span className="muted">{t('notProvided')}</span>}</td><td className="max-w-xs whitespace-pre-wrap">{participant.address ?? <span className="muted">{t('notProvided')}</span>}</td><td><div className="flex flex-col items-start gap-1"><span className="badge neutral">{participant.external ? t('external') : t('internal')}</span><span className={participant.enabled ? 'badge success' : 'badge warning'}>{participant.enabled ? t('enabled') : t('disabled')}</span></div></td>{admin ? <td>{participant.login ?? <span className="muted">{t('noLogin')}</span>}<span className="cell-sub">{participant.hasPassword ? t('passwordConfigured') : t('noPassword')}</span></td> : null}<td><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" size="sm" aria-label={t('viewNamedRecord', { name: participant.name })} onClick={() => onView(participant)}>{t('viewRecord')}</Button>{admin ? <><button className="button secondary small" onClick={() => onEdit(participant)}>{t('editParticipant')}</button><Button variant="ghost" size="sm" className="text-destructive" aria-label={t('deleteNamedRecord', { name: participant.name })} onClick={() => onDelete(participant)}>{t('deleteRecord')}</Button></> : null}</div></td></tr>)} />{participants.length === 0 ? <Empty title={t('noParticipants')}>{t('createFullProfile')}</Empty> : null}</>;
}

function CrewForm({ crew, crews, participants, onCreateParticipant, onChanged }: { crew: Crew | undefined; crews: Crew[]; participants: Participant[]; onCreateParticipant: () => void; onChanged: () => void }) {
  const t = useTranslations('directory');
  const formId = useId();
  const [selectedIds, setSelectedIds] = useState<string[]>(() => crew?.people.map((person) => person.id) ?? []);
  const missing = crew?.people.filter((person) => !participants.some((entry) => entry.id === person.id)) ?? [];
  const otherMemberships = new Map<string, Crew[]>();
  for (const other of crews) {
    if (other.id === crew?.id) continue;
    for (const person of other.people) otherMemberships.set(person.id, [...(otherMemberships.get(person.id) ?? []), other]);
  }
  const conflictingIds = selectedIds.filter((id) => otherMemberships.has(id));
  return <ActionForm submitLabel={crew ? t('saveCrew') : t('createCrew')} submitDisabled={conflictingIds.length > 0} onSubmit={async (data) => {
    if (conflictingIds.length > 0) throw new Error(t('removeOtherCrewParticipants'));
    const body = { name: textField(data, 'name'), area: textField(data, 'area'), classification: z.enum(['indoor', 'outdoor']).parse(textField(data, 'classification')), enabled: data.get('enabled') === 'on', participantIds: selectedIds };
    await mutate(crew ? `/crews/${crew.id}` : '/crews', crewSchema, crew ? { ...body, version: crew.version } : body, crew ? 'PATCH' : 'POST'); onChanged();
  }}>
    <Field label={t('crewName')}><Input name="name" required maxLength={200} defaultValue={crew?.name} /></Field>
    <div className="form-grid"><Field label={t('classification')}><select name="classification" defaultValue={crew?.classification ?? 'indoor'}><option value="indoor">{t('indoor')}</option><option value="outdoor">{t('outdoor')}</option></select></Field><Field label={t('area')}><Input name="area" required defaultValue={crew?.area} /></Field></div>
    <div className="section-title mt-6"><h3>{t('defaultRoster')}</h3><Button type="button" variant="outline" size="sm" onClick={onCreateParticipant}>{t('createParticipantButton')}</Button></div>
    <p className="small muted">{t('defaultRosterRules')}</p>
    {conflictingIds.length > 0 ? <Notice tone="error">{t('otherCrewConflict')}</Notice> : null}
    <ChoiceGroup label={t('defaultCrewParticipants')}><div className="choice-list">{participants.map((person) => {
      const checked = selectedIds.includes(person.id);
      const memberships = otherMemberships.get(person.id) ?? [];
      const occupied = memberships.length > 0;
      const reasonId = `${formId}-${person.id}-membership`;
      return <div key={person.id} className={occupied ? 'text-muted-foreground' : ''}><label className={`checkbox-label ${occupied && !checked ? 'opacity-65' : ''}`}><Input type="checkbox" data-participant-id={person.id} aria-label={person.name} aria-describedby={occupied ? reasonId : undefined} checked={checked} disabled={occupied && !checked} onChange={(event) => {
        const selected = event.target.checked;
        if (selected && occupied) return;
        setSelectedIds((current) => selected ? [...current, person.id] : current.filter((id) => id !== person.id));
      }} /><span>{person.name}</span>{person.external ? <span className="badge neutral">{t('external')}</span> : null}{!person.enabled ? <span className="badge warning">{t('disabledNewStaffing')}</span> : null}</label>{occupied ? <p id={reasonId} className="mb-2 ml-6 text-[11px] leading-snug">{t('alreadyInCrew', { crews: memberships.map((memberCrew) => memberCrew.enabled ? memberCrew.name : t('disabledCrewName', { name: memberCrew.name })).join(', ') })}{checked ? t('removeCrewSelection') : ''}</p> : null}</div>;
    })}{missing.map((person) => <label className="checkbox-label" key={person.id}><Input type="checkbox" data-participant-id={person.id} aria-label={person.name} checked={selectedIds.includes(person.id)} disabled={!selectedIds.includes(person.id)} onChange={() => setSelectedIds((current) => current.filter((id) => id !== person.id))} />{person.name}<span className="badge warning">{t('profileUnavailable')}</span></label>)}</div></ChoiceGroup>
    <label className="checkbox-label"><Input type="checkbox" name="enabled" defaultChecked={crew?.enabled ?? true} />{t('enabledAssignments')}</label>
  </ActionForm>;
}
function TemplateForm({ template, skills, onChanged }: { template: TaskTemplate | undefined; skills: Skill[]; onChanged: () => void }) {
  const t = useTranslations('directory');
  const [requiredSkillIds, setRequiredSkillIds] = useState(() => template?.requiredSkillIds ?? []);
  const problems = skillSelectionProblems(requiredSkillIds, template?.requiredSkillIds ?? [], skills, t);
  return <ActionForm submitDisabled={problems.length > 0} submitLabel={template ? t('saveTemplate') : t('createTemplate')} onSubmit={async (data) => {
    const checklist = textField(data, 'checklist').split('\n').map((line) => line.trim()).filter(Boolean);
    const order = z.coerce.number().int().min(0).max(999).parse(textField(data, 'order'));
    const body = { title: textField(data, 'title'), severity: z.enum(['low', 'medium', 'high']).parse(textField(data, 'severity')), order, checklist, requiredSkillIds, enabled: data.get('enabled') === 'on' };
    await mutate(template ? `/templates/${template.id}` : '/templates', templateSchema, template ? { ...body, version: template.version } : body, template ? 'PATCH' : 'POST'); onChanged();
  }}><Field label={t('taskTitle')}><Input name="title" required maxLength={200} defaultValue={template?.title} /></Field><div className="form-grid"><Field label={t('severity')}><select name="severity" defaultValue={template?.severity ?? 'medium'}><option value="low">{t('low')}</option><option value="medium">{t('medium')}</option><option value="high">{t('high')}</option></select></Field><Field label={t('executionOrder')}><Input name="order" type="number" min={0} max={999} required defaultValue={template?.order ?? 1} /></Field></div><SkillChoices label={t('requiredSkillsEach')} skills={skills} selectedIds={requiredSkillIds} retainedIds={template?.requiredSkillIds ?? []} onChange={setRequiredSkillIds} />{problems.length > 0 ? <Notice tone="error">{problems.join(' ')}</Notice> : null}<Field label={t('checklist')} hint={t('checklistHint')}><textarea name="checklist" rows={5} required defaultValue={template?.checklist.join('\n')} /></Field><label className="checkbox-label"><Input type="checkbox" name="enabled" defaultChecked={template?.enabled ?? true} />{t('enabledAssignments')}</label></ActionForm>;
}



