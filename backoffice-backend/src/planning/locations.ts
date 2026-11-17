import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import type { OperatorActor } from '../domain/model';
import { DomainError } from '../domain/rules';
import { DeliveryStore } from '../operations/store';
import { catalogueCommand } from './catalogue-command';
import { PlanningLocationCreateSchema, PlanningLocationDetailSchema, PlanningLocationEventSchema, PlanningLocationSchema,
  PlanningLocationsSchema, PlanningLocationUpdateSchema, type PlanningLocation, type RouteLocations } from './location-contracts';

export function locationPoint(location: PlanningLocation) { return location.unloadingEntrance?.point ?? location.point; }

export function locationPointContext(location: PlanningLocation) {
  const point = locationPoint(location);
  const addressKey = createHash('sha256').update(JSON.stringify({ address: location.address, point,
    kind: location.unloadingEntrance ? 'unloading_entrance' : 'address' })).digest('hex');
  const legacySeed = location.version === 1 && location.updatedBy === null && location.coordinateSource === 'public_demo';
  return { point, addressKey: legacySeed ? null : addressKey };
}

export function locationPlanningProblems(locations: RouteLocations) {
  return [...new Map([locations.start, locations.end].map((location) => [location.id, location])).values()].flatMap((location) => {
    if (!location.enabled) return [{ code: 'location_disabled', message: `Planning location ${location.name} is disabled.`, resourceId: `location:${location.id}` }];
    if (!locationPoint(location)) return [{ code: 'location_point_missing', message: `Planning location ${location.name} needs coordinates.`, resourceId: `location:${location.id}` }];
    if (!location.demo && location.verification !== 'operator_confirmed') return [{ code: 'location_unverified', message: `Confirm the coordinates for planning location ${location.name}.`, resourceId: `location:${location.id}` }];
    return [];
  });
}

@Injectable()
export class PlanningLocations {
  constructor(@Inject(DeliveryStore) private readonly store: DeliveryStore) {}

  async list(manager: EntityManager = this.store.db.source.manager) {
    const found = await rows(manager, z.object({ data: PlanningLocationSchema }), 'SELECT data FROM planning_location ORDER BY lower(data->>\'name\'),id LIMIT 1001');
    if (found.length > 1000) throw new DomainError('PLANNING_LOCATION_LIMIT', 'The location directory exceeds its 1000-record limit; no partial list was returned');
    return PlanningLocationsSchema.parse({ locations: found.map(({ data }) => data) });
  }

  async find(manager: EntityManager, id: string) {
    const [found] = await rows(manager, z.object({ data: PlanningLocationSchema }), 'SELECT data FROM planning_location WHERE id=$1', [id]);
    if (!found) throw new NotFoundException('Planning location not found');
    return found.data;
  }

  async route(manager: EntityManager, startId: string, endId: string): Promise<RouteLocations> {
    const start = await this.find(manager, startId);
    const end = startId === endId ? start : await this.find(manager, endId);
    return { start, end };
  }

  async detail(id: string, manager?: EntityManager): Promise<z.infer<typeof PlanningLocationDetailSchema>> {
    if (!manager) return this.store.db.source.transaction('REPEATABLE READ', (snapshot) => this.detail(id, snapshot));
    const location = await this.find(manager, id);
    const events = await rows(manager, z.object({ payload: PlanningLocationEventSchema }),
      'SELECT payload FROM planning_location_event WHERE location_id=$1 ORDER BY version DESC LIMIT 1001', [id]);
    if (events.length > 1000) throw new DomainError('PLANNING_LOCATION_HISTORY_LIMIT', 'The location history exceeds its 1000-event limit');
    return PlanningLocationDetailSchema.parse({ location, history: events.map(({ payload }) => payload) });
  }

  async create(input: unknown, actor: OperatorActor) {
    const command = PlanningLocationCreateSchema.parse(input);
    return this.store.db.source.transaction((manager) => catalogueCommand(manager,
      { scope: 'locations', recordId: command.requestId, requestId: command.requestId, actor, action: 'create', input: command },
      PlanningLocationDetailSchema, async () => {
        const { requestId, reason, ...fields } = command;
        const existing = await rows(manager, z.object({ id: z.string() }), 'SELECT id FROM planning_location WHERE id=$1', [requestId]);
        if (existing.length) throw new DomainError('LOCATION_ALREADY_EXISTS', 'The planning location already exists');
        const [total] = await rows(manager, z.object({ count: z.number().int() }), 'SELECT count(*)::int AS count FROM planning_location');
        if (!total || total.count >= 1000) throw new DomainError('PLANNING_LOCATION_LIMIT', 'The location directory is limited to 1000 records');
        const now = new Date().toISOString();
        const by = { id: actor.id, name: actor.name };
        const location = PlanningLocationSchema.parse({ ...fields, id: requestId, version: 1, updatedAt: now, updatedBy: by,
          confirmedAt: fields.verification === 'operator_confirmed' ? now : null, confirmedBy: fields.verification === 'operator_confirmed' ? by : null });
        await manager.query('INSERT INTO planning_location(id,version,data) VALUES($1,$2,$3::jsonb)', [location.id, location.version, JSON.stringify(location)]);
        await this.record(manager, location, 'created', reason, actor);
        return this.detail(location.id, manager);
      }));
  }

  async update(id: string, input: unknown, actor: OperatorActor) {
    const command = PlanningLocationUpdateSchema.parse(input);
    return this.store.db.source.transaction((manager) => catalogueCommand(manager,
      { scope: 'locations', recordId: id, requestId: command.requestId, actor, action: 'update', input: command },
      PlanningLocationDetailSchema, async () => {
        const before = await this.find(manager, id);
        if (before.version !== command.version) throw new DomainError('STALE_VERSION', 'This planning location changed. Refresh and review before saving.');
        const { requestId: _requestId, version: _version, reason, ...fields } = command;
        void _requestId; void _version;
        const now = new Date().toISOString();
        const by = { id: actor.id, name: actor.name };
        const location = PlanningLocationSchema.parse({ ...fields, id, version: before.version + 1, updatedAt: now, updatedBy: by,
          confirmedAt: fields.verification === 'operator_confirmed' ? now : null, confirmedBy: fields.verification === 'operator_confirmed' ? by : null });
        await manager.query('UPDATE planning_location SET version=$2,data=$3::jsonb WHERE id=$1', [id, location.version, JSON.stringify(location)]);
        await this.record(manager, location, 'updated', reason, actor);
        return this.detail(id, manager);
      }));
  }

  private async record(manager: EntityManager, location: PlanningLocation, action: 'created' | 'updated', reason: string, actor: OperatorActor) {
    const payload = PlanningLocationEventSchema.parse({ version: location.version, action, reason, at: location.updatedAt, actor: location.updatedBy, snapshot: location });
    await manager.query('INSERT INTO planning_location_event(location_id,version,payload) VALUES($1,$2,$3::jsonb)', [location.id, location.version, JSON.stringify(payload)]);
    await this.store.audit(manager, actor, `planning.location_${action}`, { locationId: location.id, version: location.version, reason });
  }
}
