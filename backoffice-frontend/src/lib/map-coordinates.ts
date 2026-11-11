import { z } from 'zod';

export const mapCoordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export function coordinateFromText(text: string): number {
  const normalized = text.trim().replace(',', '.');
  return /^-?\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}
