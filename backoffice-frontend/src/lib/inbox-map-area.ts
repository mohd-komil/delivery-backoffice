import { z } from 'zod';

export const inboxMapAreaSchema = z.object({
  north: z.number().min(-90).max(90), south: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180), west: z.number().min(-180).max(180),
}).refine((bounds) => bounds.south < bounds.north && bounds.west < bounds.east, { message: 'Map area must have positive height and width' });

export type InboxMapArea = z.infer<typeof inboxMapAreaSchema>;

export const inboxMapAreaResultSchema = z.object({
  bounds: inboxMapAreaSchema,
  excludedMissingCoordinates: z.number().int().nonnegative(),
});

const areaParameters = ['north', 'south', 'east', 'west'] as const;
const roundedCoordinate = (value: number) => Number(value.toFixed(8));

/** Leaflet may report longitudes outside the primary world after panning. */
export function normalizeInboxMapArea(bounds: InboxMapArea): InboxMapArea | null {
  if (!areaParameters.every((key) => Number.isFinite(bounds[key]))) return null;
  const north = Math.max(-90, Math.min(90, bounds.north));
  const south = Math.max(-90, Math.min(90, bounds.south));
  const longitude = (value: number) => value >= -180 && value <= 180 ? value : ((value + 180) % 360 + 360) % 360 - 180;
  let west = longitude(bounds.west);
  let east = longitude(bounds.east);
  // A single non-wrapping filter represents world-spanning/seam-crossing views with all longitudes.
  if (bounds.east - bounds.west >= 360 || bounds.west >= bounds.east || west >= east) {
    west = -180;
    east = 180;
  }
  const result = inboxMapAreaSchema.safeParse({
    north: roundedCoordinate(north), south: roundedCoordinate(south),
    east: roundedCoordinate(east), west: roundedCoordinate(west),
  });
  return result.success ? result.data : null;
}

export function appendInboxMapArea(query: URLSearchParams, area: InboxMapArea | null): void {
  for (const key of areaParameters) {
    query.delete(key);
    if (area) query.set(key, area[key].toFixed(8).replace(/\.?0+$/, ''));
  }
}

/** Selecting an area filters results without moving the viewport the user just chose. */
export function inboxMapViewportKey(query: string): string {
  const parameters = new URLSearchParams(query);
  for (const key of areaParameters) parameters.delete(key);
  return parameters.toString();
}
