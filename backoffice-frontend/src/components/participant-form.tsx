'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { participantSchema, type Participant, type Skill } from '@/lib/contracts';
import { skillSelectionProblems } from '@/lib/skills';
import { mutate } from '@/lib/api';
import { ActionForm, Field, Notice, optionalText } from './ui';
import { Input } from './ui/input';
import { SkillChoices } from './skill-choices';

export function ParticipantForm({ participant, skills = [], onSaved }: { participant?: Participant; skills?: Skill[]; onSaved: (saved: Participant) => void }) {
  const t = useTranslations('directory');
  const legacy = participant !== undefined && participant.firstName === null && participant.lastName === null;
  const [skillIds, setSkillIds] = useState(() => participant?.skillIds ?? []);
  const problems = skillSelectionProblems(skillIds, participant?.skillIds ?? [], skills, t);
  return <ActionForm submitLabel={participant ? t('saveParticipant') : t('createParticipant')} submitDisabled={problems.length > 0} onSubmit={async (data) => {
    const firstName = optionalText(data, 'firstName');
    const lastName = optionalText(data, 'lastName');
    if ((!firstName || !lastName) && !(legacy && firstName === null && lastName === null)) throw new Error(t('bothNames'));
    const login = optionalText(data, 'login');
    const passwordValue = data.get('password');
    const password = typeof passwordValue === 'string' ? passwordValue : '';
    if (password && (password.length < 15 || password.length > 256)) throw new Error(t('passwordLength'));
    if (login && (!participant?.hasPassword || participant.login === null) && !password) throw new Error(t('passwordNewLogin'));
    const body = {
      firstName, lastName, preferredName: optionalText(data, 'preferredName'), phoneNumber: optionalText(data, 'phoneNumber'),
      address: optionalText(data, 'address'), login, external: data.get('external') === 'on', enabled: data.get('enabled') === 'on', skillIds,
      ...(password ? { password } : {}), ...(participant ? { version: participant.version } : {}),
    };
    const saved = await mutate(participant ? `/participants/${participant.id}` : '/participants', participantSchema, body, participant ? 'PATCH' : 'POST');
    onSaved(saved);
  }}>
    {legacy ? <Notice>{t('legacyParticipant')}</Notice> : null}
    <div className="form-grid"><Field label={t('firstName')}><Input name="firstName" required={!legacy} maxLength={2000} autoComplete="off" defaultValue={participant?.firstName ?? ''} /></Field><Field label={t('lastName')}><Input name="lastName" required={!legacy} maxLength={2000} autoComplete="off" defaultValue={participant?.lastName ?? ''} /></Field></div>
    <Field label={t('preferredName')}><Input name="preferredName" maxLength={2000} autoComplete="off" defaultValue={participant?.preferredName ?? ''} /></Field>
    <Field label={t('phoneNumber')}><Input name="phoneNumber" type="tel" maxLength={4000} autoComplete="off" defaultValue={participant?.phoneNumber ?? ''} /></Field>
    <Field label={t('address')}><textarea name="address" rows={3} maxLength={4000} autoComplete="off" defaultValue={participant?.address ?? ''} /></Field>
    <div className="flex flex-wrap gap-x-6"><label className="checkbox-label"><Input type="checkbox" name="external" defaultChecked={participant?.external ?? false} />{t('externalSpecialist')}</label><label className="checkbox-label"><Input type="checkbox" name="enabled" defaultChecked={participant?.enabled ?? true} />{t('enabledNewStaffing')}</label></div>
    <SkillChoices label={t('participantSkills')} skills={skills} selectedIds={skillIds} retainedIds={participant?.skillIds ?? []} onChange={setSkillIds} />
    {problems.length > 0 ? <Notice tone="error">{problems.join(' ')}</Notice> : null}
    <section className="mt-6 border-t border-border pt-4"><h3>{t('futureFrontofficeCredentials')}</h3><p className="small muted mt-2">{t('credentialStorage')}</p>
      <Field label={t('login')}><Input name="login" maxLength={200} autoComplete="off" defaultValue={participant?.login ?? ''} /></Field>
      <Field label={participant?.hasPassword ? t('optionalNewPassword') : t('password')} hint={t('passwordHint')}><Input name="password" type="password" minLength={15} maxLength={256} autoComplete="new-password" /></Field>
      {participant?.hasPassword ? <p className="small muted">{t('passwordHidden')}</p> : null}
    </section>
  </ActionForm>;
}
