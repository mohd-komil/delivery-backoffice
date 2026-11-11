import { createTranslator } from 'next-intl';
import { en } from '@/i18n/messages/directory';
import type { Appointment, Skill, SkillSnapshot } from './contracts';

export type TranslateDirectoryMessage = (key: keyof typeof en, values?: Record<string, string | number>) => string;
export const translateDirectoryInEnglish: TranslateDirectoryMessage = createTranslator({ locale: 'en', messages: en });

export function skillReferences(ids: readonly string[], skills: readonly Skill[], translate = translateDirectoryInEnglish): SkillSnapshot[] {
  return [...new Set(ids)].map((id) => ({
    id,
    name: skills.find((skill) => skill.id === id)?.name ?? translate('unavailableSkillWithId', { id: id.slice(0, 8) }),
  }));
}

export function mergeSkillRequirements(requirements: readonly SkillSnapshot[]): SkillSnapshot[] {
  return [...new Map(requirements.map((skill) => [skill.id, skill])).values()];
}

export function assignmentSkillRequirements(assignment: Appointment['assignments'][number]): SkillSnapshot[] {
  return mergeSkillRequirements(assignment.tasks.flatMap((task) => task.requiredSkillsSnapshot ?? []));
}

export function missingParticipantSkills(person: { skillIds: readonly string[] }, requirements: readonly SkillSnapshot[]): SkillSnapshot[] {
  return requirements.filter((skill) => !person.skillIds.includes(skill.id));
}

export function unavailableRequiredSkills(requirements: readonly SkillSnapshot[], skills: readonly Skill[]): SkillSnapshot[] {
  return requirements.filter((required) => skills.find((skill) => skill.id === required.id)?.enabled !== true);
}

export function skillSelectionProblems(selected: readonly string[], retained: readonly string[], skills: readonly Skill[], translate = translateDirectoryInEnglish): string[] {
  return selected.flatMap((id) => {
    const skill = skills.find((entry) => entry.id === id);
    if (!skill) return [translate('skillMissingSelection')];
    return !skill.enabled && !retained.includes(id) ? [translate('skillDisabledSelection', { name: skill.name })] : [];
  });
}
