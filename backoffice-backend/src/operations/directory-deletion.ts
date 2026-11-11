import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { rows } from '../database/database';
import { IdSchema, type OperatorActor } from '../domain/model';
import { DirectoryDeletionSchema, VersionSchema } from './contracts';
import type { DeliveryStore } from './store';

const directories = {
  participant: { table: 'person', label: 'Participant' },
  crew: { table: 'crew', label: 'Crew' },
  template: { table: 'task_template', label: 'Task template' },
} as const;
export type DeletableDirectory = keyof typeof directories;

/** Only unused catalogue records can be deleted; snapshots are never rewritten. */
export async function deleteDirectoryEntry(store: DeliveryStore, kind: DeletableDirectory, rawId: string, input: unknown, actor: OperatorActor) {
  if (actor.role !== 'admin') throw new ForbiddenException('Administrator permission required');
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
    }
    // Search exact string values, not substrings. This includes cancelled visits,
    // superseded results, transport drivers and future nested immutable snapshots.
    const [references] = await rows(manager, z.object({ exists: z.boolean() }), `SELECT
      EXISTS(SELECT 1 FROM delivery d, LATERAL jsonb_path_query(d.data, 'strict $.** ? (@.type() == "string")') AS ref(value)
        WHERE lower(ref.value #>> '{}')=$1)
      OR EXISTS(SELECT 1 FROM route_draft r, LATERAL jsonb_path_query(r.data, 'strict $.** ? (@.type() == "string")') AS ref(value)
        WHERE lower(ref.value #>> '{}')=$1)
      OR EXISTS(SELECT 1 FROM reservation WHERE lower(resource)=ANY($2::text[]))
      OR EXISTS(SELECT 1 FROM transport_reservation WHERE lower(resource)=ANY($2::text[])) AS exists`, [id, [`person:${id}`, `crew:${id}`]]);
    if (references?.exists) throw new ConflictException(`${label} is referenced by delivery history or planning. Disable it instead of deleting.`);
    if (kind === 'participant') await manager.query('DELETE FROM participant_skill WHERE person_id=$1', [id]);
    if (kind === 'crew') await manager.query('DELETE FROM crew_member WHERE crew_id=$1', [id]);
    await manager.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
    await store.audit(manager, actor, `${kind}.deleted`, { id, version });
    return DirectoryDeletionSchema.parse({ id, deleted: true });
  });
}
