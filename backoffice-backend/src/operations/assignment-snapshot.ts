import type { Assignment, PersonSnapshot, SkillSnapshot, TaskTemplate } from '../domain/model';
import { instantiateTask } from '../domain/rules';

/** Shared immutable assignment construction after each command's own eligibility/authorization checks. */
export function instantiateAssignment(
  crew: { id: string; name: string }, people: readonly PersonSnapshot[], templates: readonly TaskTemplate[],
  requirements: readonly SkillSnapshot[], id: (key: string) => string,
): Assignment {
  return {
    id: id('assignment'), crewId: crew.id, crewName: crew.name, people: people.map((person) => structuredClone(person)),
    tasks: templates.map((template) => {
      const requiredIds = new Set((template.requiredSkillIds ?? []).map((skillId) => skillId.toLowerCase()));
      return instantiateTask(template, id(`task:${template.id}`), template.checklist.map((_, index) => id(`task:${template.id}:check:${index}`)),
        requirements.filter((skill) => requiredIds.has(skill.id.toLowerCase())));
    }),
  };
}
