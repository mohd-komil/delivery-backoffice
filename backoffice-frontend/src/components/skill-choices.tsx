'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { Skill, SkillSnapshot } from '@/lib/contracts';
import { ChoiceGroup } from './ui';
import { Input } from './ui/input';

export function SkillChoices({ label, skills, selectedIds, onChange, retainedIds = [] }: { label: string; skills: Skill[]; selectedIds: string[]; onChange: (ids: string[]) => void; retainedIds?: readonly string[] }) {
  const t = useTranslations('directory');
  const groupId = useId();
  const missing = selectedIds.filter((id) => !skills.some((skill) => skill.id === id));
  return <ChoiceGroup label={label}><div className="choice-list">{skills.map((skill) => {
    const checked = selectedIds.includes(skill.id);
    const disabled = !skill.enabled && !checked && !retainedIds.includes(skill.id);
    const reasonId = `${groupId}-${skill.id}`;
    return <div key={skill.id}><label className={`checkbox-label ${disabled ? 'text-muted-foreground opacity-65' : ''}`}><Input type="checkbox" data-skill-id={skill.id} aria-label={skill.name} aria-describedby={!skill.enabled ? reasonId : undefined} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked ? [...new Set([...selectedIds, skill.id])] : selectedIds.filter((id) => id !== skill.id))} /><span>{skill.name}</span></label>{skill.description ? <p className="mb-1 ml-6 text-[11px] text-muted-foreground">{skill.description}</p> : null}{!skill.enabled ? <p id={reasonId} className="mb-2 ml-6 text-[11px] text-muted-foreground">{t(checked ? 'skillDisabledSelected' : 'skillDisabledNewSelections')}</p> : null}</div>;
  })}{missing.map((id) => <label className="checkbox-label" key={id}><Input type="checkbox" checked onChange={() => onChange(selectedIds.filter((entry) => entry !== id))} />{t('removeMissingSkill', { id: id.slice(0, 8) })}</label>)}{skills.length === 0 && missing.length === 0 ? <p className="small muted py-3">{t('noSkillsCreated')}</p> : null}</div></ChoiceGroup>;
}

export function SkillBadges({ ids, skills }: { ids: readonly string[]; skills: readonly Skill[] }) {
  const t = useTranslations('directory');
  return <div className="mt-1 flex flex-wrap gap-1">{ids.length === 0 ? <span className="small muted">{t('none')}</span> : ids.map((id) => {
    const skill = skills.find((entry) => entry.id === id);
    return <span key={id} className={`badge ${skill?.enabled ? 'neutral' : 'warning'}`}>{skill && !skill.enabled ? t('disabledSkillName', { name: skill.name }) : skill?.name ?? t('skillUnavailable')}</span>;
  })}</div>;
}

export function RecordedSkillBadges({ skills }: { skills: readonly SkillSnapshot[] | undefined }) {
  const t = useTranslations('directory');
  return skills && skills.length > 0 ? <div className="my-1 flex flex-wrap gap-1" aria-label={t('recordedRequiredSkills')}>{skills.map((skill) => <span className="badge neutral" key={skill.id}>{skill.name}</span>)}</div> : null;
}
