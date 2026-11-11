import type { AvailableParticipant, Skill, SkillSnapshot } from './contracts';
import { missingParticipantSkills, unavailableRequiredSkills } from './skills';

export type ParticipantChoiceFilter = 'all' | 'available' | 'busy' | 'missingSkills' | 'selected';

export type ParticipantChoiceState = {
  person: AvailableParticipant;
  selected: boolean;
  assignedElsewhere: boolean;
  busy: boolean;
  missingSkills: SkillSnapshot[];
  unavailableSkills: SkillSnapshot[];
  available: boolean;
  disabled: boolean;
};

export function participantChoiceStates(people: readonly AvailableParticipant[], options: {
  selectedIds: readonly string[];
  assignedElsewhereIds: readonly string[];
  retainedIds: readonly string[];
  requiredSkills: readonly SkillSnapshot[];
  skills: readonly Skill[];
}): ParticipantChoiceState[] {
  const unavailableSkills = unavailableRequiredSkills(options.requiredSkills, options.skills);
  return people.map((person) => {
    const selected = options.selectedIds.includes(person.id);
    const assignedElsewhere = options.assignedElsewhereIds.includes(person.id);
    const busy = person.busy || assignedElsewhere;
    const missingSkills = missingParticipantSkills(person, options.requiredSkills);
    const available = (person.enabled || options.retainedIds.includes(person.id))
      && !busy && missingSkills.length === 0 && unavailableSkills.length === 0;
    return { person, selected, assignedElsewhere, busy, missingSkills, unavailableSkills, available, disabled: !selected && !available };
  });
}

export function matchesParticipantChoiceFilter(choice: ParticipantChoiceState, filter: ParticipantChoiceFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'available': return choice.available;
    case 'busy': return choice.busy;
    case 'missingSkills': return choice.missingSkills.length > 0 || choice.unavailableSkills.length > 0;
    case 'selected': return choice.selected;
  }
}
