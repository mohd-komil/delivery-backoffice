import type { AvailableParticipant, Skill, SkillSnapshot } from './contracts';
import { missingParticipantSkills, translateDirectoryInEnglish, unavailableRequiredSkills } from './skills';

export type CrewStaffSelection = { id: string; crewName: string; participantIds: string[] };

export function staffingSelectionProblems(rows: readonly CrewStaffSelection[], translate = translateDirectoryInEnglish): string[] {
  const problems: string[] = [];
  if (rows.length === 0) problems.push(translate('selectCrew'));
  const owners = new Map<string, string>();
  const repeated = new Set<string>();
  for (const row of rows) {
    if (row.participantIds.length === 0) problems.push(translate('crewNeedsParticipant', { crew: row.crewName }));
    for (const id of row.participantIds) {
      if (owners.has(id)) repeated.add(id);
      else owners.set(id, row.id);
    }
  }
  if (repeated.size > 0) problems.push(translate('staffSelectedTwice'));
  return problems;
}

export function replaceStaffSelection(rows: readonly CrewStaffSelection[], rowId: string, participantId: string, selected: boolean): CrewStaffSelection[] {
  return rows.map((row) => row.id === rowId ? { ...row, participantIds: selected ? [...new Set([...row.participantIds, participantId])] : row.participantIds.filter((id) => id !== participantId) } : row);
}

export function staffingAvailabilityProblems(rows: readonly CrewStaffSelection[], people: readonly AvailableParticipant[], retained: readonly CrewStaffSelection[] = [], translate = translateDirectoryInEnglish): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    for (const id of row.participantIds) {
      const person = people.find((entry) => entry.id === id);
      if (!person) problems.push(translate('staffProfileMissing', { crew: row.crewName }));
      else if (person.busy) problems.push(translate('staffOverlappingAppointment', { name: person.name }));
      else if (!person.enabled && !retained.some((entry) => entry.id === row.id && entry.participantIds.includes(id))) problems.push(translate('staffDisabled', { name: person.name }));
    }
  }
  return [...new Set(problems)];
}

export function staffingSkillProblems(rows: readonly CrewStaffSelection[], people: readonly AvailableParticipant[], requirements: ReadonlyMap<string, readonly SkillSnapshot[]>, skills: readonly Skill[], translate = translateDirectoryInEnglish): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const required = requirements.get(row.id) ?? [];
    const unavailable = unavailableRequiredSkills(required, skills);
    if (unavailable.length) problems.push(translate('staffRequiredSkillsUnavailable', { crew: row.crewName, skills: unavailable.map((skill) => skill.name).join(', ') }));
    for (const id of row.participantIds) {
      const person = people.find((entry) => entry.id === id);
      if (!person) continue; // The availability check reports missing profiles.
      const missing = missingParticipantSkills(person, required);
      if (missing.length) problems.push(translate('staffNeedsSkills', { name: person.name, skills: missing.map((skill) => skill.name).join(', '), crew: row.crewName }));
    }
  }
  return problems;
}
