import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DeliveryGeographySchema } from '../domain/delivery-geography';
import { GeoPointSchema, IdSchema } from '../domain/model';
import { DeliveryMapQuerySchema, selectDeliveryList } from '../operations/delivery-list';
import { DeliveryStore } from '../operations/store';
import { DeliveryAreaSchema } from '../operations/delivery-area';
import { DeliveryPoints } from '../operations/delivery-points';
import { GeocodingMetadataSchema } from './geocoding-contracts';

const DeliveryMapJobSchema = z.object({
  deliveryId: IdSchema,
  pickingName: z.string(),
  orderNames: z.array(z.string()),
  customerName: z.string(),
  address: z.string().nullable(),
  geography: DeliveryGeographySchema,
}).strict();
export const DeliveryMapMarkerSchema = DeliveryMapJobSchema.extend({
  point: GeoPointSchema,
  pointSource: z.enum(['confirmed_entrance', 'geocoded', 'reference']),
  geocoding: GeocodingMetadataSchema.optional(),
});
export const DeliveryMapSchema = z.object({
  total: z.number().int().nonnegative(),
  mappedCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  markers: z.array(DeliveryMapMarkerSchema),
  missingCoordinates: z.array(DeliveryMapJobSchema),
  area: DeliveryAreaSchema,
}).strict();

@Injectable()
export class DeliveryMap {
  constructor(
    @Inject(DeliveryStore) private readonly store: DeliveryStore,
    @Inject(DeliveryPoints) private readonly points: DeliveryPoints,
  ) {}

  async get(input: unknown): Promise<z.infer<typeof DeliveryMapSchema>> {
    const query = DeliveryMapQuerySchema.parse(input);
    const all = await this.store.all();
    const points = await this.points.effectiveFor(all);
    const { filtered, area } = selectDeliveryList(all, query, points);
    const markers: z.infer<typeof DeliveryMapMarkerSchema>[] = [];
    const missingCoordinates: z.infer<typeof DeliveryMapJobSchema>[] = [];
    for (const { delivery, geography } of filtered) {
      const { source } = delivery;
      const job = {
        deliveryId: delivery.id, pickingName: source.pickingName,
        orderNames: (source.salesOrders ?? [{ id: source.saleOrderId, name: source.saleOrderName }]).map(({ name }) => name),
        customerName: source.customer.name, address: source.customer.address, geography,
      };
      const point = points.get(delivery.id);
      if (!point) {
        missingCoordinates.push(job);
        continue;
      }
      markers.push({ ...job, ...point });
    }
    return { total: filtered.length, mappedCount: markers.length, missingCount: missingCoordinates.length, markers, missingCoordinates, area };
  }
}
