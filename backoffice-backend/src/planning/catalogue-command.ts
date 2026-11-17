import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import type { OperatorActor } from '../domain/model';
import { DomainError } from '../domain/rules';

type CatalogueCommand = {
  scope: string; recordId: string; requestId: string; actor: OperatorActor;
  action: string; input: unknown;
};

/** The caller owns the transaction. Version and business checks belong in execute, after receipt replay. */
export async function catalogueCommand<T>(manager: EntityManager, command: CatalogueCommand,
  responseSchema: z.ZodType<T>, execute: () => Promise<T>): Promise<T> {
  if (!manager.queryRunner?.isTransactionActive) throw new Error('Catalogue commands require a transaction');
  await manager.query('SELECT pg_advisory_xact_lock(7041001)');
  const fingerprint = createHash('sha256').update(JSON.stringify({ actorId: command.actor.id, role: command.actor.role,
    action: command.action, input: command.input })).digest('hex');
  const [receipt] = await rows(manager, z.object({ fingerprint: z.string(), response: z.unknown() }),
    'SELECT fingerprint,response FROM planning_catalogue_command WHERE scope=$1 AND record_id=$2 AND request_id=$3',
    [command.scope, command.recordId, command.requestId]);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw new DomainError('REQUEST_ID_CONFLICT', 'Request ID was already used for different catalogue input or actor');
    return responseSchema.parse(receipt.response);
  }
  const response = responseSchema.parse(await execute());
  await manager.query('INSERT INTO planning_catalogue_command(scope,record_id,request_id,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)',
    [command.scope, command.recordId, command.requestId, fingerprint, JSON.stringify(response)]);
  return response;
}
