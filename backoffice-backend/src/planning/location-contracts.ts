import { z } from 'zod';
import { GeoPointSchema, IdSchema, InstantSchema } from '../domain/model';

export const PlanningLocationIdSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const PlanningLocationAddressSchema = z.object({
  street: z.string().trim().max(500), city: z.string().trim().max(200), province: z.string().trim().max(200),
  postalCode: z.string().trim().max(30), country: z.string().trim().max(100),
}).strict();
export const PlanningLocationFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200), kind: z.enum(['warehouse', 'other']), address: PlanningLocationAddressSchema,
  point: GeoPointSchema.nullable(), unloadingEntrance: z.object({ point: GeoPointSchema, note: z.string().trim().min(1).max(2000) }).strict().nullable(),
  coordinateSource: z.enum(['manual', 'public_demo']), verification: z.enum(['unverified', 'operator_confirmed']),
  enabled: z.boolean(), demo: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.coordinateSource === 'public_demo' && !value.demo) context.addIssue({ code: 'custom', path: ['demo'], message: 'Public demonstration points must remain labelled as demo' });
  if (value.verification === 'operator_confirmed' && (!value.point && !value.unloadingEntrance || !value.address.street || !value.address.city || !value.address.country)) {
    context.addIssue({ code: 'custom', path: ['verification'], message: 'Confirm a complete street, city and country and an address or unloading point' });
  }
});
export const PlanningActorSchema = z.object({ id: IdSchema, name: z.string() }).strict();
export const PlanningLocationSchema = PlanningLocationFieldsSchema.safeExtend({
  id: PlanningLocationIdSchema, version: z.number().int().positive(), updatedAt: InstantSchema,
  updatedBy: PlanningActorSchema.nullable(), confirmedAt: InstantSchema.nullable(), confirmedBy: PlanningActorSchema.nullable(),
});
const Reason = z.string().trim().min(1).max(2000);
export const PlanningLocationCreateSchema = PlanningLocationFieldsSchema.safeExtend({ requestId: IdSchema.toLowerCase(), reason: Reason });
export const PlanningLocationUpdateSchema = PlanningLocationCreateSchema.safeExtend({ version: z.number().int().positive() });
export const PlanningLocationEventSchema = z.object({
  version: z.number().int().positive(), action: z.enum(['created', 'updated', 'seeded']), reason: Reason,
  at: InstantSchema, actor: PlanningActorSchema.nullable(), snapshot: PlanningLocationSchema,
}).strict();
export const PlanningLocationDetailSchema = z.object({ location: PlanningLocationSchema, history: z.array(PlanningLocationEventSchema).max(1000) }).strict();
export const PlanningLocationsSchema = z.object({ locations: z.array(PlanningLocationSchema).max(1000) }).strict();
export const RouteLocationsSchema = z.object({ start: PlanningLocationSchema, end: PlanningLocationSchema }).strict();
export type PlanningLocation = z.infer<typeof PlanningLocationSchema>;
export type RouteLocations = z.infer<typeof RouteLocationsSchema>;
