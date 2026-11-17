import { z } from 'zod';
import { mapCoordinatesSchema } from './map-coordinates';

const actor = z.object({ id: z.uuid(), name: z.string() });
export const planningLocationFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200), kind: z.enum(['warehouse', 'other']),
  address: z.object({ street: z.string().trim().max(500), city: z.string().trim().max(200), province: z.string().trim().max(200), postalCode: z.string().trim().max(30), country: z.string().trim().max(100) }).strict(),
  point: mapCoordinatesSchema.nullable(), unloadingEntrance: z.object({ point: mapCoordinatesSchema, note: z.string().trim().min(1).max(2000) }).nullable(),
  coordinateSource: z.enum(['manual', 'public_demo']), verification: z.enum(['unverified', 'operator_confirmed']), enabled: z.boolean(), demo: z.boolean(),
}).strict();
export const planningLocationSchema = planningLocationFieldsSchema.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), version: z.number().int().positive(), updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: actor.nullable(), confirmedAt: z.iso.datetime({ offset: true }).nullable(), confirmedBy: actor.nullable(),
});
export const planningLocationDetailSchema = z.object({ location: planningLocationSchema, history: z.array(z.object({
  version: z.number().int().positive(), action: z.enum(['created', 'updated', 'seeded']), reason: z.string(),
  at: z.iso.datetime({ offset: true }), actor: actor.nullable(), snapshot: planningLocationSchema,
})).max(1000) });
export const planningLocationsSchema = z.object({ locations: z.array(planningLocationSchema).max(1000) });
export const routeLocationsSchema = z.object({ start: planningLocationSchema, end: planningLocationSchema });
export type PlanningLocation = z.infer<typeof planningLocationSchema>;
