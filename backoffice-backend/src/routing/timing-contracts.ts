import { z } from 'zod';
import { AppointmentSchema, IdSchema, InstantSchema } from '../domain/model';
import { PublicationStatusSchema } from './publication-contracts';

const deltaMinutes = z.number().nullable();
const instantComparison = z.object({
  planned: InstantSchema.nullable(), actual: InstantSchema.nullable(), deltaMinutes,
}).strict();
const durationComparison = z.object({
  planned: z.number().nonnegative().nullable(), actual: z.number().nonnegative().nullable(), deltaMinutes,
}).strict();

const durationComparisons = {
  travelMinutes: durationComparison,
  waitingMinutes: durationComparison,
  workMinutes: durationComparison,
};

export const RouteTimingSchema = z.object({
  id: IdSchema,
  status: PublicationStatusSchema,
  plan: z.object({ version: z.number().int().positive(), at: InstantSchema }).strict(),
  route: z.object({
    departAt: instantComparison,
    returnDepartAt: instantComparison,
    returnAt: instantComparison,
    ...durationComparisons,
    totalMinutes: durationComparison,
    returnTravelMinutes: durationComparison,
  }).strict(),
  stops: z.array(z.object({
    deliveryId: IdSchema,
    appointmentId: IdSchema,
    sequence: z.number().int().positive(),
    pickingName: z.string(),
    status: AppointmentSchema.shape.status,
    arrivalAt: instantComparison,
    workStartAt: instantComparison,
    workEndAt: instantComparison,
    ...durationComparisons,
    reason: z.object({
      kind: z.enum(['skipped', 'customer_absent', 'cancelled']),
      note: z.string(),
    }).strict().nullable(),
  }).strict()).max(30),
}).strict();

export type RouteTiming = z.infer<typeof RouteTimingSchema>;
