import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { WorkTimeStandardSnapshotSchema, type OperatorActor } from '../domain/model';
import { changeWorkTimes, DomainError, lineServiceStatuses } from '../domain/rules';
import { DeliveryStore } from '../operations/store';
import { catalogueCommand } from './catalogue-command';
import { ApplyTimeStandardSchema, CreateTimeStandardSchema, TimeStandardDetailSchema, TimeStandardEventSchema, TimeStandardFieldsSchema, TimeStandardSchema, UpdateTimeStandardSchema, type TimeStandard } from './time-standard-contracts';

@Injectable()
export class TimeStandards {
  constructor(@Inject(DeliveryStore) private readonly store: DeliveryStore) {}

  async list() {
    const found = await rows(this.store.db.source.manager, z.object({ data: TimeStandardSchema }),
      `SELECT data FROM planning_time_standard ORDER BY lower(data->>'name'),id LIMIT 1001`);
    if (found.length > 1000) throw new DomainError('TIME_STANDARD_LIMIT', 'The work-time catalogue exceeds its 1000-record local limit');
    return found.map(({ data }) => data);
  }
  private async get(id: string, manager: EntityManager) {
    const found = await rows(manager, z.object({ data: TimeStandardSchema }), 'SELECT data FROM planning_time_standard WHERE id=$1', [id]);
    if (!found[0]) throw new NotFoundException('Work-time standard not found');
    return found[0].data;
  }
  async detail(id: string) {
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => {
      const item = await this.get(id, manager);
      const found = await rows(manager, z.object({ payload: TimeStandardEventSchema }),
        'SELECT payload FROM planning_time_standard_event WHERE standard_id=$1 ORDER BY version DESC LIMIT 1001', [id]);
      if (found.length > 1000) throw new DomainError('TIME_STANDARD_HISTORY_LIMIT', 'The standard history exceeds its 1000-revision local limit');
      return TimeStandardDetailSchema.parse({ item, history: found.map(({ payload }) => payload) });
    });
  }
  private async save(manager: EntityManager, item: TimeStandard, previous: TimeStandard | null, actor: OperatorActor, reason: string) {
    const event = TimeStandardEventSchema.parse({ version: item.version, at: item.updatedAt, actor: { id: actor.id, name: actor.name }, reason, before: previous, after: item });
    await manager.query(`INSERT INTO planning_time_standard(id,version,data) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,data=EXCLUDED.data`, [item.id, item.version, JSON.stringify(item)]);
    await manager.query('INSERT INTO planning_time_standard_event(standard_id,version,payload) VALUES($1,$2,$3::jsonb)', [item.id, item.version, JSON.stringify(event)]);
    await this.store.audit(manager, actor, 'planning.time_standard_saved', event);
    return item;
  }
  async create(input: unknown, actor: OperatorActor) {
    const command = CreateTimeStandardSchema.parse(input);
    const { requestId, reason, ...fields } = command;
    return this.store.db.source.transaction(async (manager) => catalogueCommand(manager,
      { scope: 'time_standard', recordId: requestId, requestId, actor, action: 'create', input: command }, TimeStandardSchema, async () => {
        const count = await rows(manager, z.object({ count: z.number().int() }), 'SELECT count(*)::int AS count FROM planning_time_standard');
        if ((count[0]?.count ?? 1000) >= 1000) throw new DomainError('TIME_STANDARD_LIMIT', 'The local catalogue is limited to 1000 records');
        const item = TimeStandardSchema.parse({ ...fields, id: requestId, version: 1, updatedAt: new Date().toISOString(), updatedBy: { id: actor.id, name: actor.name } });
        return this.save(manager, item, null, actor, reason);
      }));
  }
  async update(id: string, input: unknown, actor: OperatorActor) {
    const command = UpdateTimeStandardSchema.parse(input);
    const { requestId, reason, version, ...fields } = command;
    return this.store.db.source.transaction(async (manager) => catalogueCommand(manager,
      { scope: 'time_standard', recordId: id, requestId, actor, action: 'update', input: command }, TimeStandardSchema, async () => {
        const previous = await this.get(id, manager);
        if (previous.version !== version) throw new DomainError('TIME_STANDARD_VERSION_CHANGED', 'This standard changed. Reload before editing.');
        const item = TimeStandardSchema.parse({ ...TimeStandardFieldsSchema.parse(fields), id, version: version + 1, updatedAt: new Date().toISOString(), updatedBy: { id: actor.id, name: actor.name } });
        return this.save(manager, item, previous, actor, reason);
      }));
  }
  async apply(deliveryId: string, input: unknown, actor: OperatorActor) {
    const command = ApplyTimeStandardSchema.parse(input);
    await this.store.mutate(deliveryId, command.version, actor, { name: 'work_times.standard_applied', details: (delivery) => ({
      sourceLineId: command.sourceLineId, reason: command.reason,
      saved: delivery.servicePlan?.timeEstimates?.find(({ sourceLineId }) => sourceLineId === command.sourceLineId) ?? null,
    }) }, async (delivery, manager) => {
      const standard = await this.get(command.standardId, manager);
      if (standard.version !== command.standardVersion) throw new DomainError('TIME_STANDARD_VERSION_CHANGED', 'This standard changed. Review its current version before applying.');
      if (!standard.enabled || standard.status !== 'confirmed' || standard.basis !== 'elapsed_team_minutes') throw new DomainError('TIME_STANDARD_NOT_APPLICABLE', 'Only enabled, confirmed elapsed team minutes can be applied');
      const item = delivery.source.items.find(({ sourceLineId }) => sourceLineId === command.sourceLineId);
      const service = lineServiceStatuses(delivery).find(({ sourceLineId }) => sourceLineId === command.sourceLineId)?.service;
      if (!item) throw new NotFoundException('Product line not found');
      if (item.uom.trim() !== standard.unit || service !== standard.service) throw new DomainError('TIME_STANDARD_CONTEXT_MISMATCH', 'The standard must match this exact line service and unit; no automatic unit conversion is performed');
      const next = changeWorkTimes(delivery, { sourceLineId: command.sourceLineId, ...standard.rates }, actor, new Date().toISOString());
      const saved = next.servicePlan?.timeEstimates?.find(({ sourceLineId }) => sourceLineId === command.sourceLineId);
      if (!saved) throw new Error('Confirmed standard did not create a work-time estimate');
      saved.timeStandard = WorkTimeStandardSnapshotSchema.parse({
        id: standard.id, version: standard.version, name: standard.name, service: standard.service, unit: standard.unit,
        category: standard.category, rates: standard.rates, basis: standard.basis, assumptions: standard.assumptions,
        exclusions: standard.exclusions, examples: standard.examples, sourceReference: standard.sourceReference,
      });
      return next;
    }, { id: command.requestId, input: { ...command, actorId: actor.id } });
    return this.store.detail(deliveryId);
  }
}
