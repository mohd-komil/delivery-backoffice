'use client';

import { useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { toast } from 'sonner';
import { motion, MotionConfig } from 'motion/react';
import { ApiError, errorMessage, mutate } from '@/lib/api';
import type { Crew, Participant, Skill, TaskTemplate, Vehicle } from '@/lib/contracts';
import { Dialog, DialogContent, DialogTitle, useDialogClose } from './ui/dialog';
import { Button } from './ui/button';
import { Notice } from './ui';
import { SkillBadges } from './skill-choices';

export type DirectoryRecord =
  | { kind: 'participant'; value: Participant }
  | { kind: 'crew'; value: Crew }
  | { kind: 'template'; value: TaskTemplate };

type ViewableDirectoryRecord = DirectoryRecord
  | { kind: 'skill'; value: Skill }
  | { kind: 'vehicle'; value: Vehicle };

const recordLabels = {
  participant: { title: 'participantDetails', edit: 'editParticipant', deletionHint: 'deleteParticipantHint' },
  crew: { title: 'crewDetails', edit: 'editCrew', deletionHint: 'deleteCrewHint' },
  template: { title: 'templateDetails', edit: 'editTemplate', deletionHint: 'deleteTemplateHint' },
  skill: { title: 'skillDetails', edit: 'editSkill', deletionHint: 'deleteSkillHint' },
  vehicle: { title: 'vehicleDetails', edit: 'editVehicle', deletionHint: 'deleteVehicleHint' },
} as const;

export function directoryRecordName(record: ViewableDirectoryRecord): string {
  return record.kind === 'template' ? record.value.title : record.value.name;
}

export function DirectoryRecordView({ record, available, skills, admin, canManageRecords = admin, onClose, onEdit, onDelete }: {
  record: ViewableDirectoryRecord; available: boolean; skills: Skill[]; admin: boolean; canManageRecords?: boolean; onClose: () => void;
  onEdit: () => void; onDelete: () => void;
}) {
  const t = useTranslations('directory');
  const dialog = useDialogClose(onClose);
  const title = t(recordLabels[record.kind].title);
  function item(label: string, value: ReactNode) { return <div><dt>{label}</dt><dd>{value ?? t('notProvided')}</dd></div>; }
  return <MotionConfig reducedMotion="user"><Dialog open={dialog.open} onOpenChange={(open) => { if (!open) dialog.close(); }}><DialogContent className="dialog" aria-describedby={undefined}><motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }}>
    <div className="section-title"><DialogTitle asChild><h2>{title}</h2></DialogTitle><Button variant="ghost" size="icon" aria-label={t('closeRecordDetails')} onClick={dialog.close}>×</Button></div>
    <h3 className="break-words">{directoryRecordName(record)}</h3>
    {!available ? <Notice>{t('recordUnavailable')}</Notice> : null}
    <span className={record.value.enabled ? 'badge success mt-3' : 'badge warning mt-3'}>{record.value.enabled ? t('enabled') : t('disabled')}</span>
    {record.kind === 'participant' ? <>
      <dl className="detail-grid mt-5">
        {item(t('firstName'), record.value.firstName)}{item(t('lastName'), record.value.lastName)}
        {item(t('preferredName'), record.value.preferredName)}{item(t('phoneNumber'), record.value.phoneNumber)}
        {item(t('address'), <span className="whitespace-pre-wrap break-words">{record.value.address ?? t('notProvided')}</span>)}
        {item(t('typeStatus'), record.value.external ? t('external') : t('internal'))}
        {canManageRecords ? item(t('login'), record.value.login ?? t('noLogin')) : null}
        {canManageRecords ? item(t('password'), record.value.hasPassword ? t('passwordConfigured') : t('noPassword')) : null}
      </dl>
      <h4 className="mt-5 mb-2 text-xs font-semibold">{t('participantSkills')}</h4><SkillBadges ids={record.value.skillIds} skills={skills} />
      <Link href={`/participants/${record.value.id}/calendar`} className="button secondary mt-5">{t('viewParticipantCalendar')}</Link>
    </> : record.kind === 'crew' ? <>
      <dl className="detail-grid mt-5">{item(t('classification'), t(record.value.classification))}{item(t('area'), record.value.area)}</dl>
      <h4 className="mt-5 mb-2 text-xs font-semibold">{t('defaultRoster')}</h4>
      {record.value.people.length ? <ul className="divide-y divide-border">{record.value.people.map((person) => <li key={person.id} className="flex flex-wrap items-center gap-2 py-3 text-sm"><Link className="hover:underline" href={`/participants/${person.id}/calendar`}>{person.name}</Link>{person.external ? <span className="badge neutral">{t('external')}</span> : null}</li>)}</ul> : <p className="small muted">{t('emptyRoster')}</p>}
    </> : record.kind === 'template' ? <>
      <dl className="detail-grid mt-5">{item(t('severity'), t(record.value.severity))}{item(t('executionOrder'), record.value.order)}</dl>
      <h4 className="mt-5 mb-2 text-xs font-semibold">{t('requiredSkillsEach')}</h4><SkillBadges ids={record.value.requiredSkillIds} skills={skills} />
      <h4 className="mt-5 mb-2 text-xs font-semibold">{t('checklist')}</h4><ol className="list-decimal space-y-2 pl-5 text-sm">{record.value.checklist.map((label, index) => <li key={`${index}:${label}`} className="break-words">{label}</li>)}</ol>
    </> : record.kind === 'skill' ? <>
      <dl className="detail-grid mt-5">
        {item(t('description'), <span className="whitespace-pre-wrap break-words">{record.value.description ?? t('notProvided')}</span>)}
        {item(t('recordVersion'), record.value.version)}
      </dl>
    </> : <>
      <dl className="detail-grid mt-5">
        {item(t('registrationPlate'), <span className="font-mono">{record.value.plate}</span>)}
        {item(t('ownership'), t(record.value.ownership))}
        {item(t('operationalStatus'), t(record.value.operationalStatus === 'out_of_service' ? 'outOfService' : record.value.operationalStatus))}
        {record.value.ownership === 'external' ? item(t('providerName'), record.value.providerName) : null}
        {record.value.ownership === 'external' ? item(t('providerContact'), record.value.providerContact) : null}
        {item(t('notes'), <span className="whitespace-pre-wrap break-words">{record.value.notes ?? t('notProvided')}</span>)}
        {item(t('recordVersion'), record.value.version)}
      </dl>
    </>}
    {canManageRecords && available ? <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-border pt-4"><Button variant="outline" onClick={onEdit}>{t(recordLabels[record.kind].edit)}</Button><Button variant="destructive" className="text-background" onClick={onDelete}>{t('deleteRecord')}</Button></div> : null}
  </motion.div></DialogContent></Dialog></MotionConfig>;
}

const deletedRecordSchema = z.object({ id: z.uuid(), deleted: z.literal(true) });
const recordPaths = { participant: '/participants', crew: '/crews', template: '/templates', skill: '/skills', vehicle: '/vehicles' } satisfies Record<ViewableDirectoryRecord['kind'], string>;

function deletionConflictKey(message: string): 'deleteRecordInUse' | 'deleteParticipantInRoster' | 'deleteSkillInUse' | 'deleteRecordChanged' | undefined {
  if (message === 'Participant belongs to a default crew. Remove them from the crew before deleting.') return 'deleteParticipantInRoster';
  if (message === 'Skill is assigned to participants or required by task templates. Disable it instead of deleting.') return 'deleteSkillInUse';
  for (const label of ['Participant', 'Crew', 'Task template', 'Skill', 'Vehicle']) {
    if (message === `${label} is referenced by delivery history or planning. Disable it instead of deleting.`) return 'deleteRecordInUse';
    if (message === `${label} changed. Reload before deleting.`) return 'deleteRecordChanged';
  }
  return undefined;
}

export function DirectoryDeleteDialog<RecordType extends ViewableDirectoryRecord>({ record, currentVersion, onClose, onDeleted }: {
  record: RecordType; currentVersion: number | undefined; onClose: () => void; onDeleted: (record: RecordType) => void;
}) {
  const t = useTranslations('directory');
  const dialog = useDialogClose(onClose);
  const locale = useLocale();
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const stale = currentVersion !== record.value.version;
  const conflictKey = failure instanceof ApiError && failure.status === 409 ? deletionConflictKey(failure.message) : undefined;
  async function remove() {
    if (submitting.current || stale) return;
    submitting.current = true; setSaving(true); setFailure(null);
    try {
      const result = await mutate(`${recordPaths[record.kind]}/${record.value.id}`, deletedRecordSchema, { version: record.value.version }, 'DELETE');
      if (result.id !== record.value.id) throw new Error(t('deleteUnexpectedRecord'));
      onDeleted(record);
      toast.success(t('recordDeleted'));
    } catch (error: unknown) { setFailure(error); }
    finally { submitting.current = false; setSaving(false); }
  }
  return <MotionConfig reducedMotion="user"><Dialog open={dialog.open} onOpenChange={(open) => { if (!open && !saving) dialog.close(); }}><DialogContent className="dialog" aria-describedby={undefined} onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }} onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }} onPointerDownOutside={(event) => { if (saving) event.preventDefault(); }}><motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }}>
    <DialogTitle asChild><h2 className="break-words">{t('deleteRecordTitle', { name: directoryRecordName(record) })}</h2></DialogTitle>
    <p className="mt-4 text-sm leading-relaxed">{t('deleteRecordWarning')}</p>
    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(recordLabels[record.kind].deletionHint)}</p>
    {stale ? <div className="mt-4"><Notice>{t('deleteRecordChanged')}</Notice></div> : null}
    {failure !== null ? <div className="mt-4"><Notice tone="error">{conflictKey ? t(conflictKey) : errorMessage(failure, locale)}</Notice></div> : null}
    <div className="mt-6 flex flex-wrap justify-end gap-2"><Button ref={cancel} variant="outline" disabled={saving} onClick={dialog.close}>{t('cancelDelete')}</Button><Button variant="destructive" className="text-background" disabled={saving || stale} onClick={() => { void remove(); }}>{saving ? t('deletingRecord') : t('confirmDeleteRecord')}</Button></div>
  </motion.div></DialogContent></Dialog></MotionConfig>;
}
