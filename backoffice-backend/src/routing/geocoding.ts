import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { DestinationAddressKeySchema, destinationAddressKey } from '../domain/destination-address';
import { IdSchema, InstantSchema, type Delivery, type OperatorActor } from '../domain/model';
import { DomainError } from '../domain/rules';
import { sourcePlanningBlocked } from '../domain/source-import';
import { DeliveryStore } from '../operations/store';
import { GeoapifyClient, geoapifyAddressProblem, type GeoapifyLookupResult } from './geoapify-client';
import { GeoapifyCandidateSchema } from './geocoding-contracts';

export const GeocodingInputSchema = z.object({
  addressKey: DestinationAddressKeySchema, deliveryVersion: z.number().int().positive(),
}).strict();
export const GeocodingAcceptInputSchema = GeocodingInputSchema.extend({ recordVersion: z.number().int().positive() }).strict();
export const GeocodingResponseSchema = z.object({
  provider: z.literal('geoapify'), configured: z.boolean(),
  addressKey: DestinationAddressKeySchema, deliveryVersion: z.number().int().positive(),
  recordVersion: z.number().int().positive().nullable(),
  status: z.enum(['not_requested', 'pending', 'accepted', 'review_required', 'not_found', 'failed', 'invalid_address', 'not_configured', 'rate_limited', 'quota_exceeded']),
  reason: z.string().max(100).nullable(), retryAt: InstantSchema.nullable(),
  candidate: GeoapifyCandidateSchema.nullable(), acceptance: z.enum(['automatic', 'operator']).nullable(),
}).strict();
export type GeocodingResponse = z.infer<typeof GeocodingResponseSchema>;
type GeocodingInput = z.infer<typeof GeocodingInputSchema>;
type Identity = { sourceInstance: string; addressKey: string; customerId: number };
const RecordSchema = z.object({
  status: z.enum(['pending', 'accepted', 'review_required', 'not_found', 'failed']),
  version: z.number().int().positive(), candidate: GeoapifyCandidateSchema.nullable(),
  acceptance: z.enum(['automatic', 'operator']).nullable(), reason: z.string().nullable(),
  requestToken: IdSchema.nullable(), leaseUntil: z.date().nullable(), retryAfter: z.date().nullable(),
});
type GeocodingRecord = z.infer<typeof RecordSchema>;
const recordColumns = `status,version,candidate,acceptance,reason,request_token AS "requestToken",
  lease_until AS "leaseUntil",retry_after AS "retryAfter"`;
const quotaLock = 7041011;
const leaseMilliseconds = 30_000;

function addressProblem(delivery: Delivery): string | null {
  return delivery.sourceReview || sourcePlanningBlocked(delivery) ? 'source_review' : geoapifyAddressProblem(delivery.source.customer);
}

function view(delivery: Delivery, configured: boolean, record?: GeocodingRecord): GeocodingResponse {
  const problem = addressProblem(delivery);
  const expired = record?.status === 'pending' && (record.leaseUntil?.getTime() ?? 0) <= Date.now();
  return {
    provider: 'geoapify', configured, addressKey: destinationAddressKey(delivery.source.customer), deliveryVersion: delivery.version,
    recordVersion: record?.version ?? null,
    status: problem ? 'invalid_address' : expired ? 'failed' : record?.status ?? (configured ? 'not_requested' : 'not_configured'),
    reason: problem ?? (expired ? 'lookup_interrupted' : record ? record.reason : configured ? null : 'unconfigured'),
    retryAt: (record?.status === 'pending' ? record.leaseUntil : record?.retryAfter)?.toISOString() ?? null,
    candidate: problem ? null : record?.candidate ?? null,
    acceptance: problem ? null : record?.acceptance ?? null,
  };
}

@Injectable()
export class AddressGeocoding {
  constructor(
    @Inject(DeliveryStore) private readonly store: DeliveryStore,
    @Inject(GeoapifyClient) private readonly provider: Pick<GeoapifyClient, 'getSettings' | 'lookup'>,
  ) {}

  async get(id: string): Promise<GeocodingResponse> {
    const delivery = await this.store.get(id);
    const identity = await this.identity(this.store.db.source.manager, delivery);
    const settings = await this.provider.getSettings();
    return view(delivery, settings.configured, await this.find(this.store.db.source.manager, identity));
  }

  /** Read cache state in one bounded query; this never requests coordinates. */
  async getMany(deliveries: readonly Delivery[]): Promise<Map<string, GeocodingResponse>> {
    if (deliveries.length > 5000) throw new Error('Geocoding status scan exceeds the local delivery limit');
    if (deliveries.length === 0) return new Map();
    const settings = await this.provider.getSettings();
    const requested = deliveries.map((delivery) => ({ delivery_id: delivery.id, delivery_version: delivery.version,
      address_key: destinationAddressKey(delivery.source.customer) }));
    const records = await rows(this.store.db.source.manager, RecordSchema.extend({ deliveryId: IdSchema }), `
      SELECT requested.delivery_id AS "deliveryId",record.*
      FROM jsonb_to_recordset($1::jsonb) AS requested(delivery_id uuid,delivery_version integer,address_key text)
      JOIN delivery d ON d.id=requested.delivery_id AND d.version=requested.delivery_version
      JOIN LATERAL (SELECT ${recordColumns} FROM address_geocoding
        WHERE source_instance=d.source_instance AND address_key=requested.address_key) record ON true`, [JSON.stringify(requested)]);
    const byId = new Map(records.map((record) => [record.deliveryId, record]));
    return new Map(deliveries.map((delivery) => [delivery.id, view(delivery, settings.configured, byId.get(delivery.id))]));
  }

  async locate(id: string, input: GeocodingInput, principal: OperatorActor): Promise<GeocodingResponse> {
    const settings = await this.provider.getSettings();
    // Only the short claim transaction holds locks. No database transaction spans the provider request.
    const claim = await this.store.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const delivery = await this.store.get(id, manager, true);
      const identity = await this.identity(manager, delivery);
      this.requireCurrent(delivery, identity, input);
      await manager.query('SELECT pg_advisory_xact_lock($1)', [quotaLock]);
      const existing = await this.find(manager, identity);
      const response = view(delivery, settings.configured, existing);
      if (addressProblem(delivery)) return { kind: 'existing' as const, response };
      const [clock] = await rows(manager, z.object({ now: z.date() }), 'SELECT now() AS now');
      if (!clock) throw new Error('Database clock is unavailable');
      const now = clock.now;
      if (existing && (existing.status === 'accepted' || existing.status === 'review_required'
        || existing.status === 'pending' && (existing.leaseUntil?.getTime() ?? 0) > now.getTime()
        || (existing.retryAfter?.getTime() ?? 0) > now.getTime())) return { kind: 'existing' as const, response };
      if (!settings.configured) return { kind: 'existing' as const, response: { ...response, status: 'not_configured' as const, reason: 'unconfigured' } };
      await manager.query(`INSERT INTO geocoding_budget(provider,budget_day,used,next_request_at)
        VALUES('geoapify',(now() AT TIME ZONE 'UTC')::date,0,now()) ON CONFLICT(provider) DO NOTHING`);
      const [budget] = await rows(manager, z.object({ used: z.number().int(), sameDay: z.boolean(), nextRequest: z.date() }), `
        SELECT used,budget_day=(now() AT TIME ZONE 'UTC')::date AS "sameDay",next_request_at AS "nextRequest"
        FROM geocoding_budget WHERE provider='geoapify' FOR UPDATE`);
      if (!budget) throw new Error('Geocoding quota state is unavailable');
      if (budget.sameDay && budget.used >= settings.dailyLimit) {
        const tomorrow = new Date(now);
        tomorrow.setUTCHours(24, 0, 0, 0);
        return { kind: 'existing' as const, response: { ...response, status: 'quota_exceeded' as const, reason: 'daily_limit', retryAt: tomorrow.toISOString() } };
      }
      if (budget.nextRequest.getTime() > now.getTime()) {
        return { kind: 'existing' as const, response: { ...response, status: 'rate_limited' as const, reason: 'request_interval', retryAt: budget.nextRequest.toISOString() } };
      }
      await manager.query(`UPDATE geocoding_budget SET used=CASE WHEN budget_day=(now() AT TIME ZONE 'UTC')::date THEN used+1 ELSE 1 END,
        budget_day=(now() AT TIME ZONE 'UTC')::date,next_request_at=now()+interval '1 second' WHERE provider='geoapify'`);
      const token = randomUUID();
      await manager.query(`INSERT INTO address_geocoding AS current(source_instance,address_key,provider,status,version,request_token,lease_until)
        VALUES($1,$2,'geoapify','pending',1,$3,$4)
        ON CONFLICT(source_instance,address_key) DO UPDATE SET status='pending',version=current.version+1,
          candidate=NULL,acceptance=NULL,reason=NULL,request_token=excluded.request_token,lease_until=excluded.lease_until,
          retry_after=NULL,accepted_by_id=NULL,accepted_at=NULL,updated_at=now()`,
      [identity.sourceInstance, identity.addressKey, token, new Date(now.getTime() + leaseMilliseconds)]);
      await this.store.audit(manager, principal, 'address_geocoding.requested', { addressKey: identity.addressKey, provider: 'geoapify' }, id);
      return { kind: 'claimed' as const, delivery, identity, token };
    });
    if (claim.kind === 'existing') return claim.response;
    let result: GeoapifyLookupResult;
    try {
      result = await this.provider.lookup(claim.delivery.source.customer);
    } catch {
      // Do not expose addresses, request URLs, credentials or arbitrary provider exceptions.
      result = { status: 'failed', reason: 'provider_unavailable', candidate: null };
    }
    const finished = await this.store.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const delivery = await this.store.get(id, manager, true);
      const identity = await this.identity(manager, delivery);
      const current = await this.find(manager, claim.identity);
      if (!current || current.requestToken !== claim.token) return { stale: true as const };
      const stale = delivery.version !== input.deliveryVersion || identity.addressKey !== input.addressKey
        || identity.sourceInstance !== claim.identity.sourceInstance || identity.customerId !== claim.identity.customerId || addressProblem(delivery) !== null;
      const outcome: GeoapifyLookupResult = stale ? { status: 'failed', reason: 'address_changed', candidate: null } : result;
      const retrySeconds = stale ? 0 : outcome.status === 'not_found' ? 86400 : outcome.status === 'failed' ? 300 : null;
      const [saved] = await rows(manager, RecordSchema, `WITH saved AS (UPDATE address_geocoding SET
          status=$4,candidate=$5::jsonb,acceptance=$6,reason=$7,request_token=NULL,lease_until=NULL,
          retry_after=CASE WHEN $8::integer IS NULL THEN NULL ELSE now()+$8::integer*interval '1 second' END,
          accepted_at=CASE WHEN $4='accepted' THEN now() ELSE NULL END,updated_at=now(),version=version+1
        WHERE source_instance=$1 AND address_key=$2 AND request_token=$3 RETURNING ${recordColumns}) SELECT * FROM saved`,
      [claim.identity.sourceInstance, claim.identity.addressKey, claim.token, outcome.status,
        outcome.candidate === null ? null : JSON.stringify(GeoapifyCandidateSchema.parse(outcome.candidate)),
        outcome.status === 'accepted' ? 'automatic' : null, outcome.reason, retrySeconds]);
      if (!saved) return { stale: true as const };
      await this.store.audit(manager, principal, 'address_geocoding.result', {
        addressKey: claim.identity.addressKey, status: outcome.status, reason: outcome.reason,
        precision: outcome.candidate?.precision ?? null, acceptance: saved.acceptance,
      }, id);
      return stale ? { stale: true as const } : { stale: false as const, response: view(delivery, settings.configured, saved) };
    });
    if (finished.stale) throw new DomainError('GEOCODING_ADDRESS_CHANGED', 'Delivery or source address changed. Reload before locating it again.');
    return finished.response;
  }

  async accept(id: string, input: z.infer<typeof GeocodingAcceptInputSchema>, principal: OperatorActor): Promise<GeocodingResponse> {
    const settings = await this.provider.getSettings();
    return this.store.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const delivery = await this.store.get(id, manager, true);
      const identity = await this.identity(manager, delivery);
      this.requireCurrent(delivery, identity, input);
      if (addressProblem(delivery)) throw new DomainError('GEOCODING_ADDRESS_REQUIRED', 'A current, complete source address is required.');
      const existing = await this.find(manager, identity);
      if (existing?.status === 'accepted' && (existing.version === input.recordVersion || existing.version === input.recordVersion + 1) && existing.acceptance === 'operator') {
        return view(delivery, settings.configured, existing);
      }
      if (!existing || existing.version !== input.recordVersion || existing.status !== 'review_required' || existing.candidate === null) {
        throw new DomainError('GEOCODING_VERSION_CONFLICT', 'The address suggestion changed. Reload before accepting it.');
      }
      const [accepted] = await rows(manager, RecordSchema, `WITH accepted AS (UPDATE address_geocoding SET status='accepted',acceptance='operator',reason=NULL,
        version=version+1,accepted_by_id=$4,accepted_at=now(),updated_at=now()
        WHERE source_instance=$1 AND address_key=$2 AND version=$3 AND status='review_required' RETURNING ${recordColumns}) SELECT * FROM accepted`,
      [identity.sourceInstance, identity.addressKey, input.recordVersion, principal.id]);
      if (!accepted) throw new DomainError('GEOCODING_VERSION_CONFLICT', 'The address suggestion changed. Reload before accepting it.');
      await this.store.audit(manager, principal, 'address_geocoding.accepted', {
        addressKey: identity.addressKey, recordVersion: accepted.version, precision: accepted.candidate?.precision,
      }, id);
      return view(delivery, settings.configured, accepted);
    });
  }

  private requireCurrent(delivery: Delivery, identity: Identity, input: GeocodingInput) {
    if (delivery.version !== input.deliveryVersion || identity.addressKey !== input.addressKey) {
      throw new DomainError('GEOCODING_ADDRESS_CHANGED', 'Delivery or source address changed. Reload before locating it again.');
    }
  }

  private async identity(manager: EntityManager, delivery: Delivery): Promise<Identity> {
    const [identity] = await rows(manager, z.object({ sourceInstance: z.string() }),
      'SELECT source_instance AS "sourceInstance" FROM delivery WHERE id=$1', [delivery.id]);
    if (!identity) throw new Error('Delivery source identity is missing');
    return { ...identity, addressKey: destinationAddressKey(delivery.source.customer), customerId: delivery.source.customer.id };
  }

  private async find(manager: EntityManager, identity: Pick<Identity, 'sourceInstance' | 'addressKey'>) {
    return (await rows(manager, RecordSchema, `SELECT ${recordColumns} FROM address_geocoding WHERE source_instance=$1 AND address_key=$2`,
      [identity.sourceInstance, identity.addressKey]))[0];
  }
}
