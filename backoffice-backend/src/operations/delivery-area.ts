import { z } from 'zod';
import type { DeliveryView } from '../domain/model';
import type { EffectiveDeliveryPoint } from './delivery-points';

const coordinateQuery = (limit: number) => z.string().max(24).regex(/^-?\d{1,3}(?:\.\d{1,16})?$/)
  .refine((value) => Number(value) >= -limit && Number(value) <= limit);
export const areaQueryShape = {
  north: coordinateQuery(90).optional(), south: coordinateQuery(90).optional(),
  east: coordinateQuery(180).optional(), west: coordinateQuery(180).optional(),
};
type AreaQuery = { view?: DeliveryView; north?: string; south?: string; east?: string; west?: string };
export const AreaBoundsSchema = z.object({
  north: z.number().min(-90).max(90), south: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180), west: z.number().min(-180).max(180),
}).strict();
export const DeliveryAreaSchema = z.object({
  bounds: AreaBoundsSchema, excludedMissingCoordinates: z.number().int().nonnegative(),
}).strict().nullable();

export function validateAreaQuery(query: AreaQuery, context: z.RefinementCtx) {
  const supplied = [query.north, query.south, query.east, query.west].filter((value) => value !== undefined).length;
  if (!supplied) return;
  if (supplied !== 4 || query.view !== 'inbox') {
    context.addIssue({ code: 'custom', path: ['north'], message: 'Area bounds require all four coordinates and the Inbox view' });
    return;
  }
  if (Number(query.south) >= Number(query.north) || Number(query.west) >= Number(query.east)) {
    context.addIssue({ code: 'custom', path: ['north'], message: 'Area bounds must have south < north and west < east without wrapping' });
  }
}

export function areaBounds(query: AreaQuery): z.infer<typeof AreaBoundsSchema> | null {
  if (query.north === undefined || query.south === undefined || query.east === undefined || query.west === undefined) return null;
  return { north: Number(query.north), south: Number(query.south), east: Number(query.east), west: Number(query.west) };
}

export function pointInArea(value: EffectiveDeliveryPoint | undefined, bounds: z.infer<typeof AreaBoundsSchema>) {
  return value !== undefined && value.point.latitude >= bounds.south && value.point.latitude <= bounds.north
    && value.point.longitude >= bounds.west && value.point.longitude <= bounds.east;
}
