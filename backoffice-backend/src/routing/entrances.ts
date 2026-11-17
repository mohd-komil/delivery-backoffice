import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { DestinationAddressKeySchema, destinationAddressKey } from '../domain/destination-address';
import { GeoPointSchema, IdSchema, InstantSchema, type Delivery, type OperatorActor } from '../domain/model';
import { DomainError } from '../domain/rules';
import { DeliveryStore } from '../operations/store';
import { DeliveryPoints } from '../operations/delivery-points';
import { GeocodingMetadataSchema } from './geocoding-contracts';

export const ConfirmEntranceInputSchema = z.object({
  addressKey: DestinationAddressKeySchema,
  deliveryVersion: z.number().int().positive(),
  version: z.number().int().positive().nullable(),
  point: GeoPointSchema,
  confirmed: z.literal(true),
}).strict();

const EntranceSchema = z.object({
  point: GeoPointSchema,
  version: z.number().int().positive(),
  confirmedAt: InstantSchema,
  confirmedBy: z.object({ id: IdSchema, name: z.string() }),
});

export const EntranceResponseSchema = z.object({
  addressKey: DestinationAddressKeySchema,
  deliveryVersion: z.number().int().positive(),
  entrance: EntranceSchema.nullable(),
  stale: z.boolean(),
  address: z.object({ street: z.string().nullable(), city: z.string().nullable(), country: z.string().nullable() }),
  referencePoint: GeoPointSchema.nullable(),
  referenceGeocoding: GeocodingMetadataSchema.optional(),
  mapConfig: z.object({ key: z.string(), mapId: z.string().optional() }).nullable(),
});

const EntranceRecordSchema = GeoPointSchema.extend({
  version: z.number().int().positive(),
  confirmedAt: z.date(),
  confirmedById: IdSchema,
  confirmedByName: z.string(),
});
type EntranceRecord = z.infer<typeof EntranceRecordSchema>;

const entranceColumns = 'latitude, longitude, version, confirmed_at AS "confirmedAt", confirmed_by_id AS "confirmedById", confirmed_by_name AS "confirmedByName"';
const confirmAction = 'destination_entrance.confirmed';

function entranceView(delivery: Delivery, addressKey: string, record: EntranceRecord | undefined, stale = false,
  referencePoint?: z.infer<typeof GeoPointSchema>, referenceGeocoding?: z.infer<typeof GeocodingMetadataSchema>) {
  const { address, city, country } = delivery.source.customer;
  return {
    addressKey,
    deliveryVersion: delivery.version,
    entrance: record ? {
      point: { latitude: record.latitude, longitude: record.longitude },
      version: record.version,
      confirmedAt: record.confirmedAt.toISOString(),
      confirmedBy: { id: record.confirmedById, name: record.confirmedByName },
    } : null,
    stale,
    address: { street: address, city, country },
    referencePoint: referencePoint ?? delivery.routePoint ?? null,
    ...(referenceGeocoding ? { referenceGeocoding } : {}),
  };
}

@Injectable()
export class DestinationEntrances {
  constructor(@Inject(DeliveryStore) private readonly store: DeliveryStore, @Inject(DeliveryPoints) private readonly points: DeliveryPoints) {}

  async get(id: string) {
    const manager = this.store.db.source.manager;
    const delivery = await this.store.get(id, manager);
    const identity = await this.identity(manager, delivery);
    const record = await this.find(manager, identity);
    const [prior] = record ? [] : await rows(manager, z.object({ stale: z.boolean() }), `
      SELECT EXISTS (
        SELECT 1 FROM audit a
        WHERE a.delivery_id=$1 AND (
          (a.action=$2 AND (a.details->>'addressKey' <> $3 OR a.details->>'customerId' <> $4::text))
          OR (a.action IN ('source.refreshed', 'source.review_required', 'source.candidate_accepted') AND EXISTS (
            SELECT 1 FROM destination_entrance prior
            WHERE prior.source_instance=$5
              AND prior.source_customer_id::text=(a.details #>> '{previousDestination,customerId}')
              AND prior.address_key=(a.details #>> '{previousDestination,addressKey}')
          ))
        )
      ) AS stale`, [id, confirmAction, identity.addressKey, identity.customerId, identity.sourceInstance]);
    const geocoded = await this.points.geocodedFor([delivery], manager);
    return entranceView(delivery, identity.addressKey, record, prior?.stale ?? false, geocoded.get(id)?.point, geocoded.get(id)?.geocoding);
  }

  async confirm(id: string, input: z.infer<typeof ConfirmEntranceInputSchema>, principal: OperatorActor) {
    return this.store.db.source.transaction(async (manager) => {
      // Coordinate with the importer so the recorded entrance always belongs to the checked address.
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const delivery = await this.store.get(id, manager, true);
      const identity = await this.identity(manager, delivery);
      if (identity.addressKey !== input.addressKey || delivery.version !== input.deliveryVersion) {
        throw new DomainError('ENTRANCE_ADDRESS_CHANGED', 'Delivery or source address changed. Reload before confirming the entrance.');
      }
      const { address, city, country } = delivery.source.customer;
      if (delivery.sourceReview || !address?.trim() || !city?.trim() || !country?.trim()) {
        throw new DomainError('ENTRANCE_ADDRESS_REQUIRED', 'A current street address, city and country are required to confirm an entrance.');
      }
      const existing = await this.find(manager, identity);
      if ((existing?.version ?? null) !== input.version) {
        throw new DomainError('ENTRANCE_VERSION_CONFLICT', 'Unloading entrance changed. Reload before confirming.');
      }
      const { latitude, longitude } = input.point;
      const [record] = await rows(manager, EntranceRecordSchema, `WITH confirmed AS (
        INSERT INTO destination_entrance AS current (
          source_instance, source_customer_id, address_key, latitude, longitude, version, confirmed_by_id, confirmed_by_name
        ) VALUES ($1,$2,$3,$4,$5,1,$6,$7)
        ON CONFLICT (source_instance, source_customer_id, address_key) DO UPDATE SET
          latitude=excluded.latitude, longitude=excluded.longitude, version=current.version+1,
          confirmed_at=now(), confirmed_by_id=excluded.confirmed_by_id, confirmed_by_name=excluded.confirmed_by_name
        WHERE current.version=$8
        RETURNING ${entranceColumns}
      ) SELECT * FROM confirmed`, [
        identity.sourceInstance, identity.customerId, identity.addressKey, latitude, longitude, principal.id, principal.name, input.version,
      ]);
      if (!record) throw new DomainError('ENTRANCE_VERSION_CONFLICT', 'Unloading entrance changed. Reload before confirming.');
      await this.store.audit(manager, principal, confirmAction, {
        addressKey: identity.addressKey, customerId: identity.customerId, version: record.version,
      }, id);
      const geocoded = await this.points.geocodedFor([delivery], manager);
      return entranceView(delivery, identity.addressKey, record, false, geocoded.get(id)?.point, geocoded.get(id)?.geocoding);
    });
  }

  async pointsFor(deliveries: readonly Delivery[], manager: EntityManager = this.store.db.source.manager) {
    return this.points.confirmedFor(deliveries, manager);
  }

  async effectivePointsFor(deliveries: readonly Delivery[], manager: EntityManager = this.store.db.source.manager) {
    return this.points.effectiveFor(deliveries, manager);
  }

  private async identity(manager: EntityManager, delivery: Delivery) {
    const [identity] = await rows(manager, z.object({ sourceInstance: z.string() }),
      'SELECT source_instance AS "sourceInstance" FROM delivery WHERE id=$1', [delivery.id]);
    if (!identity) throw new Error('Delivery source identity is missing');
    return {
      ...identity,
      customerId: delivery.source.customer.id,
      addressKey: destinationAddressKey(delivery.source.customer),
    };
  }

  private async find(manager: EntityManager, identity: { sourceInstance: string; customerId: number; addressKey: string }) {
    const [record] = await rows(manager, EntranceRecordSchema, `SELECT ${entranceColumns} FROM destination_entrance
      WHERE source_instance=$1 AND source_customer_id=$2 AND address_key=$3`,
    [identity.sourceInstance, identity.customerId, identity.addressKey]);
    return record;
  }
}
