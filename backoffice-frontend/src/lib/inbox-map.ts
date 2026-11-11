import { z } from 'zod';
import { geographySchema } from './contracts';
import { mapCoordinatesSchema } from './map-coordinates';
import { inboxMapAreaResultSchema } from './inbox-map-area';

const mapDeliverySchema = z.object({
  deliveryId: z.uuid(), pickingName: z.string(), orderNames: z.array(z.string()), customerName: z.string(),
  address: z.string().nullable(), geography: geographySchema,
});

export const inboxMapSchema = z.object({
  total: z.number().int().nonnegative(), mappedCount: z.number().int().nonnegative(), missingCount: z.number().int().nonnegative(),
  markers: z.array(mapDeliverySchema.extend({ point: mapCoordinatesSchema, pointSource: z.enum(['confirmed_entrance', 'reference']) })),
  missingCoordinates: z.array(mapDeliverySchema),
  area: inboxMapAreaResultSchema.nullable().default(null),
}).superRefine((data, context) => {
  if (data.total !== data.mappedCount + data.missingCount || data.markers.length !== data.mappedCount || data.missingCoordinates.length !== data.missingCount) {
    context.addIssue({ code: 'custom', message: 'Map counts do not match the deliveries' });
  }
  const ids = [...data.markers, ...data.missingCoordinates].map((delivery) => delivery.deliveryId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Map delivery IDs must be unique' });
});
export type InboxMapData = z.infer<typeof inboxMapSchema>;
export type MapDelivery = z.infer<typeof mapDeliverySchema>;
