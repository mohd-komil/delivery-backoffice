import { ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { rows } from '../database/database';
import { IdSchema, type OperatorActor } from '../domain/model';
import { DirectoryDeletionSchema, VersionSchema } from './contracts';
import type { DeliveryStore } from './store';

const directories = {
  participant: { table: 'person', label: 'Participant' },
  crew: { table: 'crew', label: 'Crew' },
  template: { table: 'task_template', label: 'Task template' },
  skill: { table: 'skill', label: 'Skill' },
  vehicle: { table: 'vehicle', label: 'Vehicle' },
} as const;
export type DeletableDirectory = keyof typeof directories;

/** Only unused catalogue records can be deleted; snapshots are never rewritten. */
export async function deleteDirectoryEntry(store: DeliveryStore, kind: DeletableDirectory, rawId: string, input: unknown, actor: OperatorActor) {
  // The existing Backoffice guard supplies an authenticated admin/operator; Crew uses a separate session.
  const id = IdSchema.parse(rawId).toLowerCase();
  const { version } = VersionSchema.strict().parse(input);
  const { table, label } = directories[kind];
  return store.db.source.transaction(async (manager) => {
    // Shares the scheduling/catalogue lock so an assignment cannot race this check.
    await manager.query('SELECT pg_advisory_xact_lock(7041001)');
    const [current] = await rows(manager, VersionSchema, `SELECT version FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    if (!current) throw new NotFoundException(`${label} not found`);
    if (current.version !== version) throw new ConflictException(`${label} changed. Reload before deleting.`);
    if (kind === 'participant') {
      const [membership] = await rows(manager, z.object({ exists: z.boolean() }), 'SELECT EXISTS(SELECT 1 FROM crew_member WHERE person_id=$1) AS exists', [id]);
      if (membership?.exists) throw new ConflictException('Participant belongs to a default crew. Remove them from the crew before deleting.');
      const [calendar] = await rows(manager, z.object({ exists: z.boolean() }), 'SELECT EXISTS(SELECT 1 FROM planning_calendar_entry WHERE person_id=$1) AS exists', [id]);
      if (calendar?.exists) throw new ConflictException('Participant has scheduling history. Disable the participant instead of deleting.');
    }
    if (kind === 'skill') {
      const [usage] = await rows(manager, z.object({ exists: z.boolean() }), `SELECT
        EXISTS(SELECT 1 FROM participant_skill WHERE skill_id=$1::uuid)
        OR EXISTS(SELECT 1 FROM task_template t,
          LATERAL jsonb_array_elements_text(COALESCE(t.data->'requiredSkillIds','[]'::jsonb)) AS requirement(id)
          WHERE lower(requirement.id)=$1::text) AS exists`, [id]);
      if (usage?.exists) throw new ConflictException('Skill is assigned to participants or required by task templates. Disable it instead of deleting.');
    }
    // Search exact string values, not substrings. This includes cancelled visits,
    // superseded results, transport drivers and future nested immutable snapshots.
    const [references] = await rows(manager, z.object({ exists: z.boolean() }), `SELECT
      EXISTS(SELECT 1 FROM delivery d, LATERAL jsonb_path_query(d.data, 'strict $.** ? (@.type() == "string")') AS ref(value)
        WHERE lower(ref.value #>> '{}')=$1)
      OR EXISTS(SELECT 1 FROM route_draft r, LATERAL jsonb_path_query(r.data, 'strict $.** ? (@.type() == "string")') AS ref(value)
        WHERE lower(ref.value #>> '{}')=$1)
      OR EXISTS(SELECT 1 FROM route_publication r, LATERAL jsonb_path_query(r.data, 'strict $.** ? (@.type() == "string")') AS ref(value)
        WHERE lower(ref.value #>> '{}')=$1)
      OR EXISTS(SELECT 1 FROM route_revision r, LATERAL jsonb_path_query(r.data, 'strict $.** ? (@.type() == "string")') AS ref(value)
        WHERE lower(ref.value #>> '{}')=$1)
      OR EXISTS(SELECT 1 FROM reservation WHERE lower(resource)=ANY($2::text[]))
      OR EXISTS(SELECT 1 FROM transport_reservation WHERE lower(resource)=ANY($2::text[]))
      OR EXISTS(SELECT 1 FROM route_reservation WHERE lower(resource)=ANY($2::text[])) AS exists`, [id, [`person:${id}`, `crew:${id}`, `vehicle:${id}`]]);
    if (references?.exists) throw new ConflictException(`${label} is referenced by delivery history or planning. Disable it instead of deleting.`);
    if (kind === 'participant') await manager.query('DELETE FROM participant_skill WHERE person_id=$1', [id]);
    if (kind === 'crew') await manager.query('DELETE FROM crew_member WHERE crew_id=$1', [id]);
    await manager.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
    await store.audit(manager, actor, `${kind}.deleted`, { id, version });
    return DirectoryDeletionSchema.parse({ id, deleted: true });
  });
}
