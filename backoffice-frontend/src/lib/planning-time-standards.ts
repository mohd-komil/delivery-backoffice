import { z } from 'zod';
import { serviceTypeSchema } from './service-types';
import { workTimeRatesSchema } from './work-times';

const text = z.string().trim().max(2000);
export const timeStandardFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200), service: serviceTypeSchema, unit: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(200).nullable(), rates: workTimeRatesSchema,
  basis: z.enum(['elapsed_team_minutes', 'person_minutes', 'unspecified']), assumptions: text, exclusions: text,
  examples: text, sourceReference: text, status: z.enum(['draft', 'confirmed']), enabled: z.boolean(),
}).strict();
const actor = z.object({ id: z.uuid(), name: z.string() });
export const timeStandardSchema = timeStandardFieldsSchema.extend({
  id: z.uuid(), version: z.number().int().positive(), updatedAt: z.iso.datetime({ offset: true }), updatedBy: actor,
});
export const timeStandardsListSchema = z.array(timeStandardSchema).max(1000);
export const timeStandardDetailSchema = z.object({ item: timeStandardSchema, history: z.array(z.object({
  version: z.number().int().positive(), at: z.iso.datetime({ offset: true }), actor, reason: text.min(1),
  before: timeStandardSchema.nullable(), after: timeStandardSchema,
})).max(1000) });
export const applyTimeStandardSchema = z.object({ version: z.number().int().positive(), requestId: z.uuid(), sourceLineId: z.number().int().positive(),
  standardId: z.uuid(), standardVersion: z.number().int().positive(), reason: text.min(1) }).strict();
export type TimeStandard = z.infer<typeof timeStandardSchema>;
export type ApplyTimeStandard = z.infer<typeof applyTimeStandardSchema>;
export function canApplyTimeStandard(item: TimeStandard, service: string | null, unit: string): boolean {
  return item.enabled && item.status === 'confirmed' && item.basis === 'elapsed_team_minutes' && item.service === service && item.unit === unit.trim();
}
