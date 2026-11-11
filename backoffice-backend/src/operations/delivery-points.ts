import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { destinationAddressKey } from '../domain/destination-address';
import { GeoPointSchema, IdSchema, type Delivery } from '../domain/model';
import { DeliveryStore } from './store';

export type EffectiveDeliveryPoint = {
  point: z.infer<typeof GeoPointSchema>;
  pointSource: 'confirmed_entrance' | 'reference';
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

  async effectiveFor(deliveries: readonly Delivery[], manager: EntityManager = this.store.db.source.manager) {
    const confirmed = await this.confirmedFor(deliveries, manager);
    const points = new Map<string, EffectiveDeliveryPoint>();
    for (const delivery of deliveries) {
      const { address, city, country } = delivery.source.customer;
      if (!address?.trim() || !city?.trim() || !country?.trim()) continue;
      const entrance = confirmed.get(delivery.id);
      // The importer invalidates reference points on customer/address changes.
      const point = entrance ?? delivery.routePoint;
      if (point) points.set(delivery.id, { point, pointSource: entrance ? 'confirmed_entrance' : 'reference' });
    }
    return points;
  }
}
