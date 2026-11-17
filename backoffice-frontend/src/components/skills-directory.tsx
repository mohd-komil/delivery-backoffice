'use client';

import { Combobox } from './ui/combobox';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { apiRequest, errorMessage, mutate } from '@/lib/api';
import { participantSchema, skillSchema, type Participant, type Skill, type User } from '@/lib/contracts';
import { skillSelectionProblems } from '@/lib/skills';
import { ActionForm, Empty, Field, Notice, Pending, optionalText, textField } from './ui';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogTitle, useDialogState } from './ui/dialog';
import { SkillBadges, SkillChoices } from './skill-choices';
import { PageHeadingTitle } from './page-help';
import { DataTable } from './ui/data-table';
import { Button } from './ui/button';
import { DirectoryDeleteDialog, DirectoryRecordView } from './directory-record-dialogs';

export function SkillsDirectory({ user }: { user: User }) {
  const t = useTranslations('directory');
  const locale = useLocale();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [tab, setTab] = useState<'skills' | 'participants'>('skills');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<number | null>(null);
  const [failureState, setFailureState] = useState<{ cause: unknown } | null>(null);
  const error = failureState ? errorMessage(failureState.cause, locale) : null;
  const [editingSkill, setEditingSkill, skillDialogOpen] = useDialogState<{ key: string; base: Skill | undefined }>();
  const [editingParticipant, setEditingParticipant, participantDialogOpen] = useDialogState<Participant>();
  const [viewing, setViewing] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const read = useRef<AbortController | null>(null);
  const loading = revision !== settled;
  const admin = user.role === 'admin';
  const canManageRecords = admin || user.role === 'operator';
  function refresh() { setRevision((value) => value + 1); }
  useEffect(() => {
    const controller = new AbortController(); read.current = controller;
    void Promise.all([apiRequest('/skills', z.array(skillSchema), { signal: controller.signal }), apiRequest('/participants', z.array(participantSchema), { signal: controller.signal })]).then(
      ([nextSkills, nextParticipants]) => { if (!controller.signal.aborted) { setSkills(nextSkills); setParticipants(nextParticipants); setFailureState(null); setSettled(revision); } },
      (failure: unknown) => { if (!controller.signal.aborted) { setFailureState({ cause: failure }); setSettled(revision); } },
    );
    return () => controller.abort();
  }, [revision]);
  function savedSkill(saved: Skill) { read.current?.abort(); setSkills((current) => [...(current ?? []).filter((skill) => skill.id !== saved.id), saved]); setEditingSkill(null); refresh(); }
  function savedParticipant(saved: Participant) { read.current?.abort(); setParticipants((current) => [...(current ?? []).filter((person) => person.id !== saved.id), saved]); setEditingParticipant(null); refresh(); }
  function deletedSkill(id: string) {
    read.current?.abort(); setSkills((current) => current?.filter((skill) => skill.id !== id) ?? null);
    setDeleting(null); refresh();
  }
  const viewedSkill = viewing ? skills?.find((skill) => skill.id === viewing.id) : undefined;
  const query = search.trim().toLocaleLowerCase();
  const filteredSkills = skills?.filter((skill) => `${skill.name} ${skill.description ?? ''}`.toLocaleLowerCase().includes(query) && (status === 'all' || skill.enabled === (status === 'enabled'))) ?? [];
  const filteredParticipants = participants?.filter((person) => person.name.toLocaleLowerCase().includes(query) && (status === 'all' || person.enabled === (status === 'enabled'))) ?? [];
  const skillChanged = editingSkill?.base && skills?.find((skill) => skill.id === editingSkill.base?.id)?.version !== editingSkill.base.version;
  const participantChanged = editingParticipant && participants?.find((person) => person.id === editingParticipant.id)?.version !== editingParticipant.version;
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('skillsEyebrow')}</p><PageHeadingTitle title={t('skills')} topic={tab === 'skills' ? 'skills' : 'participantSkills'} /><p className="subtitle">{t('skillsSubtitle')}</p></div><div className="flex flex-wrap gap-2"><button className="button secondary" disabled={loading} onClick={refresh}>{t('refreshSkills')}</button>{canManageRecords && tab === 'skills' ? <button className="button" onClick={() => setEditingSkill({ key: 'new', base: undefined })}>{t('newSkillButton')}</button> : null}</div></div>
    <div className="tabbar"><button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>{t('skills')}</button><button className={tab === 'participants' ? 'active' : ''} onClick={() => setTab('participants')}>{t('participantSkills')}</button></div>
    <div className="directory-filters"><Field label={tab === 'skills' ? t('searchSkills') : t('searchParticipants')}><Input value={search} onChange={(event) => setSearch(event.target.value)} /></Field><Field label={t('status')}><Combobox value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">{t('allStatuses')}</option><option value="enabled">{t('enabled')}</option><option value="disabled">{t('disabled')}</option></Combobox></Field></div>
    <div className="mb-3 flex h-10 items-center gap-3 text-xs" role="status" aria-live="polite">{error ? <><span className="max-h-10 flex-1 overflow-y-auto text-destructive">{error}{skills ? " " + t('previousData') : ''}</span><button className="text-button" disabled={loading} onClick={refresh}>{t('retrySkills')}</button></> : <span className="muted">{skills && loading ? t('refreshingSkills') : ''}</span>}</div>
    {!skills || !participants ? loading ? <Pending>{t('loadingSkills')}</Pending> : <Empty title={t('skillsUnavailable')}>{t('retryCatalog')}</Empty> : tab === 'skills' ? <><DataTable containerClassName="table-wrap relative skills-table-region" className="skills-table min-w-[700px]" caption={t('skillsCaption')} resetKey={JSON.stringify([tab, search, status])} header={<tr><th scope="col">{t('skill')}</th><th scope="col">{t('description')}</th><th scope="col">{t('participants')}</th><th scope="col">{t('status')}</th>{canManageRecords ? <th scope="col"><span className="sr-only">{t('manageSkill')}</span></th> : null}</tr>} rows={filteredSkills.map((skill) => <tr key={skill.id}><th scope="row" className="bg-transparent text-xs font-medium tracking-normal text-foreground normal-case"><button type="button" className="reference text-left" aria-label={t('viewNamedRecord', { name: skill.name })} onClick={() => setViewing(skill)}>{skill.name}</button></th><td className="max-w-sm whitespace-pre-wrap">{skill.description ?? <span className="muted">{t('notProvided')}</span>}</td><td>{participants.filter((person) => person.skillIds.includes(skill.id)).length}</td><td><span className={skill.enabled ? 'badge success' : 'badge warning'}>{skill.enabled ? t('enabled') : t('disabled')}</span></td>{canManageRecords ? <td><div className="flex flex-wrap gap-2"><button className="button secondary small" aria-label={t('editNamedSkill', { name: skill.name })} onClick={() => setEditingSkill({ key: skill.id, base: skill })}>{t('editSkill')}</button><Button variant="ghost" size="sm" className="text-destructive" aria-label={t('deleteNamedRecord', { name: skill.name })} onClick={() => setDeleting(skill)}>{t('deleteRecord')}</Button></div></td> : null}</tr>)} />{filteredSkills.length === 0 ? <Empty title={skills.length === 0 ? t('noSkills') : t('noMatchingSkills')}>{t('createSkillHint')}</Empty> : null}</> : <><DataTable containerClassName="table-wrap relative participant-skills-table-region" className="participant-skills-table min-w-[700px]" caption={t('participantSkillsCaption')} resetKey={JSON.stringify([tab, search, status])} header={<tr><th scope="col">{t('participant')}</th><th scope="col">{t('skills')}</th><th scope="col">{t('status')}</th>{canManageRecords ? <th scope="col"><span className="sr-only">{t('manageParticipantSkills')}</span></th> : null}</tr>} rows={filteredParticipants.map((person) => <tr key={person.id}><th scope="row" className="bg-transparent text-xs font-medium tracking-normal text-foreground normal-case">{person.name}</th><td><SkillBadges ids={person.skillIds} skills={skills} /></td><td><span className={person.enabled ? 'badge success' : 'badge warning'}>{person.enabled ? t('enabled') : t('disabled')}</span></td>{canManageRecords ? <td><button className="button secondary small" aria-label={t('editSkillsFor', { name: person.name })} onClick={() => setEditingParticipant(person)}>{t('editSkills')}</button></td> : null}</tr>)} />{filteredParticipants.length === 0 ? <Empty title={t('noMatchingParticipants')} /> : null}</>}
    {editingSkill && canManageRecords ? <Dialog open={skillDialogOpen} onOpenChange={(open) => { if (!open) setEditingSkill(null); }}><DialogContent className="dialog" aria-describedby={undefined}><div className="section-title"><DialogTitle asChild><h2>{editingSkill.base ? t('editSkill') : t('newSkill')}</h2></DialogTitle><button className="icon-button" aria-label={t('closeSkill')} onClick={() => setEditingSkill(null)}>×</button></div>{skillChanged ? <Notice>{t('newerSkill')}</Notice> : null}<SkillForm key={editingSkill.key} skill={editingSkill.base} onSaved={savedSkill} /></DialogContent></Dialog> : null}
    {editingParticipant && skills && canManageRecords ? <Dialog open={participantDialogOpen} onOpenChange={(open) => { if (!open) setEditingParticipant(null); }}><DialogContent className="dialog" aria-describedby={undefined}><div className="section-title"><DialogTitle asChild><h2>{t('skillsFor', { name: editingParticipant.name })}</h2></DialogTitle><button className="icon-button" aria-label={t('closeParticipantSkills')} onClick={() => setEditingParticipant(null)}>×</button></div>{participantChanged ? <Notice>{t('newerParticipantSkills')}</Notice> : null}<ParticipantSkillsForm key={editingParticipant.id} participant={editingParticipant} skills={skills} onSaved={savedParticipant} /></DialogContent></Dialog> : null}
    {viewing ? <DirectoryRecordView record={{ kind: 'skill', value: viewedSkill ?? viewing }} available={viewedSkill !== undefined} skills={skills ?? []} admin={admin} canManageRecords={canManageRecords}
      onClose={() => setViewing(null)} onEdit={() => { if (viewedSkill) { setViewing(null); setEditingSkill({ key: viewedSkill.id, base: viewedSkill }); } }}
      onDelete={() => { if (viewedSkill) { setViewing(null); setDeleting(viewedSkill); } }} /> : null}
    {deleting && canManageRecords ? <DirectoryDeleteDialog key={deleting.id} record={{ kind: 'skill', value: deleting }} currentVersion={skills?.find((skill) => skill.id === deleting.id)?.version}
      onClose={() => setDeleting(null)} onDeleted={(record) => deletedSkill(record.value.id)} /> : null}
  </>;
}

function SkillForm({ skill, onSaved }: { skill: Skill | undefined; onSaved: (saved: Skill) => void }) {
  const t = useTranslations('directory');
  return <ActionForm submitLabel={skill ? t('saveSkill') : t('createSkill')} onSubmit={async (data) => {
    const body = { name: textField(data, 'name'), description: optionalText(data, 'description'), enabled: data.get('enabled') === 'on', ...(skill ? { version: skill.version } : {}) };
    onSaved(await mutate(skill ? `/skills/${skill.id}` : '/skills', skillSchema, body, skill ? 'PATCH' : 'POST'));
  }}><Field label={t('skillName')}><Input name="name" required maxLength={200} defaultValue={skill?.name ?? ''} /></Field><Field label={t('description')}><textarea name="description" rows={3} maxLength={2000} defaultValue={skill?.description ?? ''} /></Field><label className="checkbox-label"><Input name="enabled" type="checkbox" defaultChecked={skill?.enabled ?? true} />{t('enabledAssignments')}</label><p className="small muted">{t('disabledSkillHint')}</p></ActionForm>;
}

function ParticipantSkillsForm({ participant, skills, onSaved }: { participant: Participant; skills: Skill[]; onSaved: (saved: Participant) => void }) {
  const t = useTranslations('directory');
  const [ids, setIds] = useState(participant.skillIds);
  const problems = skillSelectionProblems(ids, participant.skillIds, skills, t);
  return <ActionForm submitLabel={t('saveParticipantSkills')} submitDisabled={problems.length > 0} onSubmit={async () => {
    onSaved(await mutate(`/participants/${participant.id}/skills`, participantSchema, { version: participant.version, skillIds: ids }, 'PATCH'));
  }}><SkillChoices label={t('participantSkills')} skills={skills} selectedIds={ids} retainedIds={participant.skillIds} onChange={setIds} />{problems.length > 0 ? <Notice tone="error">{problems.join(' ')}</Notice> : null}</ActionForm>;
}
