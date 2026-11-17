import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { destinationAddressKey } from '../domain/destination-address';
import { GeoPointSchema, IdSchema, type Delivery } from '../domain/model';
import { sourcePlanningBlocked } from '../domain/source-import';
import { DeliveryStore } from './store';
import { GeoapifyCandidateSchema, GeocodingMetadataSchema } from '../routing/geocoding-contracts';

export type EffectiveDeliveryPoint = {
  point: z.infer<typeof GeoPointSchema>;
  pointSource: 'confirmed_entrance' | 'geocoded' | 'reference';
  geocoding?: z.infer<typeof GeocodingMetadataSchema>;
};

@Injectable()
export class DeliveryPoints {
  constructor(@Inject(DeliveryStore) private readonly store: DeliveryStore) {}

  async confirmedFor(deliveries: readonly Delivery[], manager: EntityManager = this.store.db.source.manager) {
    if (!deliveries.length) return new Map<string, z.infer<typeof GeoPointSchema>>();
    const requested = deliveries.map((delivery) => ({
      delivery_id: delivery.id, delivery_version: delivery.version,
      customer_id: delivery.source.customer.id, address_key: destinationAddressKey(delivery.source.customer),
    }));
    const found = await rows(manager, GeoPointSchema.extend({ deliveryId: IdSchema }), `
      SELECT d.id AS "deliveryId", e.latitude, e.longitude
      FROM jsonb_to_recordset($1::jsonb)
        AS requested(delivery_id uuid, delivery_version integer, customer_id integer, address_key text)
      JOIN delivery d ON d.id=requested.delivery_id AND d.version=requested.delivery_version
      JOIN destination_entrance e ON e.source_instance=d.source_instance
        AND e.source_customer_id=requested.customer_id AND e.address_key=requested.address_key`, [JSON.stringify(requested)]);
    return new Map(found.map(({ deliveryId, latitude, longitude }) => [deliveryId, { latitude, longitude }]));
  }

  async geocodedFor(deliveries: readonly Delivery[], manager: EntityManager = this.store.db.source.manager) {
    const points = new Map<string, EffectiveDeliveryPoint>();
    const requested = deliveries.filter((delivery) => !delivery.sourceReview && !sourcePlanningBlocked(delivery)).map((delivery) => ({
      delivery_id: delivery.id, delivery_version: delivery.version, address_key: destinationAddressKey(delivery.source.customer),
    }));
    if (!requested.length) return points;
    const found = await rows(manager, z.object({ deliveryId: IdSchema, candidate: GeoapifyCandidateSchema,
      acceptance: z.enum(['automatic', 'operator']) }), `
      SELECT d.id AS "deliveryId",g.candidate,g.acceptance
      FROM jsonb_to_recordset($1::jsonb) AS requested(delivery_id uuid,delivery_version integer,address_key text)
      JOIN delivery d ON d.id=requested.delivery_id AND d.version=requested.delivery_version
      JOIN address_geocoding g ON g.source_instance=d.source_instance AND g.address_key=requested.address_key AND g.status='accepted'`,
    [JSON.stringify(requested)]);
    for (const { deliveryId, candidate, acceptance } of found) {
      points.set(deliveryId, { point: candidate.point, pointSource: 'geocoded', geocoding: {
        provider: 'geoapify', precision: candidate.precision, confidence: candidate.confidence, attribution: candidate.attribution, acceptance,
      } });
    }
    return points;
  }

  async effectiveFor(deliveries: readonly Delivery[], manager: EntityManager = this.store.db.source.manager) {
    const confirmed = await this.confirmedFor(deliveries, manager);
    const geocoded = await this.geocodedFor(deliveries, manager);
    const points = new Map<string, EffectiveDeliveryPoint>();
    for (const delivery of deliveries) {
      const { address, city, country } = delivery.source.customer;
      if (!address?.trim() || !city?.trim() || !country?.trim()) continue;
      const entrance = confirmed.get(delivery.id);
      if (entrance) { points.set(delivery.id, { point: entrance, pointSource: 'confirmed_entrance' }); continue; }
      const matched = geocoded.get(delivery.id);
      if (matched) { points.set(delivery.id, matched); continue; }
      // The importer invalidates reference points on customer/address changes.
      const point = delivery.routePoint;
      if (point) points.set(delivery.id, { point, pointSource: 'reference' });
    }
    return points;
  }
}
