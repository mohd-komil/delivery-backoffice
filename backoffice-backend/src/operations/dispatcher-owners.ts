import { rows, type Executor } from '../database/database';
import { ResponsibleParticipantSchema } from '../domain/model';
import { DomainError } from '../domain/rules';

export async function listDispatcherOwners(executor: Executor) {
  return rows(executor, ResponsibleParticipantSchema, 'SELECT id,name FROM app_user ORDER BY name,id');
}

export async function requireDispatcherOwners(executor: Executor, ids: readonly string[], code = 'DISPATCHER_OWNER_UNAVAILABLE') {
  const distinct = [...new Set(ids.map((id) => id.toLowerCase()))];
  const owners = await rows(executor, ResponsibleParticipantSchema, 'SELECT id,name FROM app_user WHERE id=ANY($1::uuid[]) ORDER BY id', [distinct]);
  if (owners.length !== distinct.length) throw new DomainError(code, 'Choose an existing dispatcher for the follow-up owner');
  return owners;
}
