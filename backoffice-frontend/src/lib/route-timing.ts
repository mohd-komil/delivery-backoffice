import { z } from 'zod';
import { appointmentSchema } from './contracts';
import { publicationSummarySchema } from './route-publication';

const instantSchema = z.iso.datetime({ offset: true });
const durationSchema = z.number().nonnegative();

function comparisonSchema<T extends z.ZodType>(value: T) {
  return z.object({ planned: value.nullable(), actual: value.nullable(), deltaMinutes: z.number().nullable() });
}

const timeComparison = comparisonSchema(instantSchema);
const durationComparison = comparisonSchema(durationSchema);

export const routeTimingSchema = z.object({
  id: z.uuid(),
  status: publicationSummarySchema.shape.status,
  plan: z.object({ version: z.number().int().positive(), at: instantSchema }),
  route: z.object({
    departAt: timeComparison,
    returnDepartAt: timeComparison,
    returnAt: timeComparison,
    travelMinutes: durationComparison,
    waitingMinutes: durationComparison,
    workMinutes: durationComparison,
    totalMinutes: durationComparison,
    returnTravelMinutes: durationComparison,
  }),
  stops: z.array(z.object({
    deliveryId: z.uuid(),
    appointmentId: z.uuid(),
    sequence: z.number().int().positive(),
    pickingName: z.string(),
    status: appointmentSchema.shape.status,
    arrivalAt: timeComparison,
    workStartAt: timeComparison,
    workEndAt: timeComparison,
    travelMinutes: durationComparison,
    waitingMinutes: durationComparison,
    workMinutes: durationComparison,
    reason: z.object({
      kind: z.enum(['skipped', 'customer_absent', 'cancelled']),
      note: z.string(),
    }).nullable(),
  })),
});

export type RouteTiming = z.infer<typeof routeTimingSchema>;
