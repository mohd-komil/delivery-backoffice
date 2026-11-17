import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { DeliverySchema, IdSchema, type OperatorActor } from '../domain/model';
import { DomainError, effectiveResults } from '../domain/rules';
import { DeliveryStore } from '../operations/store';
import { DeliveryPoints } from '../operations/delivery-points';
import { listDispatcherOwners, requireDispatcherOwners } from '../operations/dispatcher-owners';
import { RouteRuntimeSchema } from '../routing/lifecycle-contracts';
import { routeLineStatuses } from '../routing/line-status';
import { DispatcherCaseSchema, DispatcherDetailSchema, DispatcherFactsSchema, DispatcherHistorySchema, DispatcherListSchema,
  DispatcherOwnerSchema, DispatcherQuerySchema, DispatcherUpdateSchema, type DispatcherFacts } from './contracts';
import { cargoDispatcherCases, deliveryDispatcherCases, EvidenceFileSchema } from './projections';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const RecordSchema = z.object({ key: z.string(), version: z.number().int().positive(), owner: DispatcherOwnerSchema.nullable(),
  nextAction: z.string(), note: z.string(), updatedAt: z.date(), updatedBy: DispatcherOwnerSchema, snapshot: DispatcherFactsSchema });
type Coordination = z.infer<typeof RecordSchema>;
type Case = z.infer<typeof DispatcherCaseSchema>;
const columns = `case_key AS key,version,CASE WHEN owner_id IS NULL THEN NULL ELSE jsonb_build_object('id',owner_id,'name',owner_name) END AS owner,
  next_action AS "nextAction",note,updated_at AS "updatedAt",jsonb_build_object('id',updated_by,'name',updated_by_name) AS "updatedBy",snapshot`;
function limit(count: number, maximum: number, scope: string) {
  if (count > maximum) throw new DomainError('DISPATCHER_SCAN_LIMIT', `The dispatcher queue exceeds its ${maximum}-${scope} local limit; no incomplete queue was returned`);
}
function describe(facts: DispatcherFacts, saved?: Coordination, status: 'open' | 'resolved' = 'open'): Case {
  return DispatcherCaseSchema.parse({ ...facts, status, version: saved?.version ?? 0,
    owner: saved ? saved.owner : facts.sourceOwner, ownerSource: saved ? 'coordination' : facts.sourceOwner ? 'source' : 'unassigned',
    nextAction: saved?.nextAction ?? facts.sourceAction, note: saved?.note ?? null, updatedAt: saved?.updatedAt.toISOString() ?? null,
    updatedBy: saved?.updatedBy ?? null, coordinationStale: status === 'open' && !!saved && saved.snapshot.fingerprint !== facts.fingerprint });
}

@Injectable()
export class DispatcherQueue {
  constructor(@Inject(DeliveryStore) private readonly store: DeliveryStore, @Inject(DeliveryPoints) private readonly points: DeliveryPoints) {}

  async owners() { return listDispatcherOwners(this.store.db.source.manager); }

  /** Read-only snapshot: listing never creates cases, changes source workflows or calls a geocoder. */
  private async load(manager: EntityManager): Promise<Case[]> {
    const sourceRows = await rows(manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery ORDER BY id LIMIT 5001');
    limit(sourceRows.length, 5000, 'delivery');
    const deliveries = sourceRows.map(({ data }) => data);
    const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
    const saved = await rows(manager, RecordSchema, `SELECT ${columns} FROM dispatcher_case ORDER BY case_key LIMIT 5001`);
    limit(saved.length, 5000, 'coordinated-case');
    const savedByKey = new Map(saved.map((entry) => [entry.key, entry]));
    const owners = await listDispatcherOwners(manager);
    const ownersById = new Map(owners.map((owner) => [owner.id, owner]));
    const points = await this.points.effectiveFor(deliveries, manager);
    const evidenceIds = [...new Set(deliveries.flatMap((delivery) => effectiveResults(delivery).flatMap(({ evidence }) => evidence.map(({ id }) => id))))];
    limit(evidenceIds.length, 10000, 'evidence-reference');
    const files = evidenceIds.length ? await rows(manager, EvidenceFileSchema,
      `SELECT id,delivery_id AS "deliveryId",appointment_id AS "appointmentId",item_id AS "itemId",kind,status,mime FROM file_record WHERE id=ANY($1::uuid[])`, [evidenceIds]) : [];
    const byFileId = new Map(files.map((file) => [file.id, file]));
    const active = deliveries.flatMap((delivery) => deliveryDispatcherCases(delivery, points.has(delivery.id), byFileId));
    const routes = await rows(manager, z.object({ id: IdSchema, name: z.string(), runtime: RouteRuntimeSchema }),
      `SELECT id,data->'draft'->>'name' AS name,runtime FROM route_publication WHERE status IN ('returned','closed') ORDER BY id LIMIT 5001`);
    limit(routes.length, 5000, 'returned-route');
    const links = routes.length ? await rows(manager, z.object({ routeId: IdSchema, deliveryId: IdSchema, appointmentId: IdSchema }),
      `SELECT route_id AS "routeId",delivery_id AS "deliveryId",appointment_id AS "appointmentId" FROM route_stop WHERE route_id=ANY($1::uuid[]) ORDER BY route_id,sequence,id LIMIT 150001`, [routes.map(({ id }) => id)]) : [];
    limit(links.length, 150000, 'route-stop');
    const linksByRoute = new Map<string, typeof links>();
    for (const link of links) { const group = linksByRoute.get(link.routeId) ?? []; group.push(link); linksByRoute.set(link.routeId, group); }
    for (const route of routes) {
      if (!route.runtime.returned) continue;
      const stops = (linksByRoute.get(route.id) ?? []).map((link) => {
        const delivery = byId.get(link.deliveryId);
        const appointment = delivery?.appointments.find(({ id }) => id === link.appointmentId);
        if (!delivery || !appointment) throw new DomainError('DISPATCHER_SOURCE_UNAVAILABLE', 'A returned route references unavailable work; the queue cannot safely infer resolution');
        return { ...link, delivery, appointment };
      });
      active.push(...cargoDispatcherCases(route, routeLineStatuses(stops, route.runtime), byId, ownersById));
    }
    limit(active.length, 20000, 'active-case');
    const activeByKey = new Map(active.map((entry) => [entry.key, entry]));
    if (activeByKey.size !== active.length) throw new Error('Dispatcher case identities must be unique');
    const items = active.map((entry) => describe(entry, savedByKey.get(entry.key), entry.status));
    for (const record of saved) if (!activeByKey.has(record.key)) {
      items.push(describe({ ...record.snapshot, fingerprint: digest({ key: record.key, status: 'resolved' }) }, record, 'resolved'));
    }
    return items.sort((left, right) => Number(left.status === 'resolved') - Number(right.status === 'resolved')
      || left.kind.localeCompare(right.kind) || (left.pickingName ?? '').localeCompare(right.pickingName ?? '') || left.key.localeCompare(right.key));
  }

  async list(input: unknown, actor: OperatorActor) {
    const query = DispatcherQuerySchema.parse(input);
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => {
      const all = await this.load(manager);
      const kinds = { source_review: 0, address_review: 0, issue: 0, evidence: 0, cargo: 0, signature_refusal: 0 };
      for (const item of all) kinds[item.kind]++;
      const selected = all.filter((item) => (query.status === 'all' || item.status === query.status) && (query.kind === 'all' || item.kind === query.kind)
        && (query.owner === 'all' || query.owner === 'unassigned' && item.owner === null || item.owner?.id === (query.owner === 'mine' ? actor.id : query.owner)));
      const page = Math.min(query.page, Math.max(1, Math.ceil(selected.length / 10)));
      return DispatcherListSchema.parse({ items: selected.slice((page - 1) * 10, page * 10), total: selected.length, page, pageSize: 10,
        counts: { open: all.filter(({ status }) => status === 'open').length, resolved: all.filter(({ status }) => status === 'resolved').length, kinds } });
    });
  }

  private async history(manager: EntityManager, key: string) {
    const found = await rows(manager, z.object({ payload: DispatcherHistorySchema }), 'SELECT payload FROM dispatcher_case_event WHERE case_key=$1 ORDER BY version DESC LIMIT 1001', [key]);
    limit(found.length, 1000, 'case-history');
    return found.map(({ payload }) => payload);
  }
  private async detailFrom(manager: EntityManager, key: string) {
    const item = (await this.load(manager)).find((entry) => entry.key === key);
    if (!item) throw new NotFoundException('Dispatcher case not found');
    return DispatcherDetailSchema.parse({ item, history: await this.history(manager, key) });
  }
  async detail(key: string) {
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => this.detailFrom(manager, key));
  }

  async update(key: string, input: unknown, actor: OperatorActor) {
    const command = DispatcherUpdateSchema.parse(input);
    return this.store.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const fingerprint = digest({ command, actorId: actor.id });
      const receipts = await rows(manager, z.object({ fingerprint: z.string() }),
        'SELECT request_fingerprint AS fingerprint FROM dispatcher_case_event WHERE case_key=$1 AND request_id=$2', [key, command.requestId]);
      if (receipts[0]) {
        if (receipts[0].fingerprint !== fingerprint) throw new DomainError('REQUEST_ID_CONFLICT', 'Request ID was already used for different dispatcher input');
        return this.detailFrom(manager, key);
      }
      const item = (await this.load(manager)).find((entry) => entry.key === key);
      if (!item) throw new NotFoundException('Dispatcher case not found');
      if (item.status !== 'open') throw new DomainError('DISPATCHER_CASE_RESOLVED', 'This condition is resolved in its original workflow; its coordination history is read only');
      if (command.version !== item.version) throw new DomainError('DISPATCHER_VERSION_CHANGED', 'The coordinator assignment changed. Reload before editing.');
      if (command.fingerprint !== item.fingerprint) throw new DomainError('DISPATCHER_FACTS_CHANGED', 'The underlying work changed. Review its current facts before saving a follow-up.');
      const owner = command.ownerUserId === null ? null : (await requireDispatcherOwners(manager, [command.ownerUserId]))[0] ?? null;
      const snapshot = DispatcherFactsSchema.strip().parse(item);
      const at = new Date();
      const version = item.version + 1;
      const event = DispatcherHistorySchema.parse({ version, at: at.toISOString(), actor: { id: actor.id, name: actor.name },
        owner, nextAction: command.nextAction, note: command.note, snapshot });
      await manager.query(`INSERT INTO dispatcher_case(case_key,version,owner_id,owner_name,next_action,note,updated_at,updated_by,updated_by_name,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT(case_key) DO UPDATE SET version=EXCLUDED.version,owner_id=EXCLUDED.owner_id,owner_name=EXCLUDED.owner_name,
          next_action=EXCLUDED.next_action,note=EXCLUDED.note,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by,
          updated_by_name=EXCLUDED.updated_by_name,snapshot=EXCLUDED.snapshot`,
      [key, version, owner?.id ?? null, owner?.name ?? null, command.nextAction, command.note, at, actor.id, actor.name, JSON.stringify(snapshot)]);
      await manager.query('INSERT INTO dispatcher_case_event(case_key,version,request_id,request_fingerprint,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
        [key, version, command.requestId, fingerprint, JSON.stringify(event)]);
      await this.store.audit(manager, actor, 'dispatcher.case_coordinated', { key, kind: item.kind, version, owner, nextAction: command.nextAction, note: command.note }, item.origin.deliveryId);
      const updated = describe(snapshot, { key, version, owner, nextAction: command.nextAction, note: command.note, updatedAt: at,
        updatedBy: { id: actor.id, name: actor.name }, snapshot });
      return DispatcherDetailSchema.parse({ item: updated, history: await this.history(manager, key) });
    });
  }
}
