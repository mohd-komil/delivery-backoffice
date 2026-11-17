import { z } from 'zod';
import { IdSchema, InstantSchema } from '../domain/model';

const Explanation = z.string().trim().min(1).max(2000);
export const CalendarKindSchema = z.enum(['shift', 'break', 'absence']);
export const CalendarFieldsSchema = z.object({
  personId: IdSchema.toLowerCase(), kind: CalendarKindSchema,
  startsAt: InstantSchema, endsAt: InstantSchema, timeZone: z.literal('Europe/Rome'),
  sourceReference: Explanation, note: z.string().trim().max(2000),
}).strict();
function validInterval(value: z.infer<typeof CalendarFieldsSchema>) {
  const duration = Date.parse(value.endsAt) - Date.parse(value.startsAt);
  const maxHours = value.kind === 'absence' ? 366 * 24 : value.kind === 'shift' ? 48 : 24;
  return duration > 0 && duration <= maxHours * 60 * 60_000;
}
export const CalendarCreateSchema = CalendarFieldsSchema.extend({ requestId: IdSchema.toLowerCase(), reason: Explanation })
  .refine(validInterval, 'Use a positive interval: shifts up to 48 hours, breaks up to 24 hours, absences up to 366 days');
export const CalendarUpdateSchema = CalendarFieldsSchema.extend({
  requestId: IdSchema.toLowerCase(), reason: Explanation, version: z.number().int().positive(), archived: z.boolean(),
}).refine(validInterval, 'Use a positive interval: shifts up to 48 hours, breaks up to 24 hours, absences up to 366 days');
const ActorSchema = z.object({ id: IdSchema, name: z.string() }).strict();
export const CalendarEntrySchema = CalendarFieldsSchema.extend({
  id: IdSchema, version: z.number().int().positive(), personName: z.string(), archived: z.boolean(),
  updatedAt: InstantSchema, updatedBy: ActorSchema,
});
export type CalendarEntry = z.infer<typeof CalendarEntrySchema>;
export const CalendarHistorySchema = z.object({
  version: z.number().int().positive(), action: z.enum(['created', 'updated', 'archived', 'restored']),
  reason: Explanation, at: InstantSchema, actor: ActorSchema, entry: CalendarEntrySchema,
}).strict();
export const CalendarDetailSchema = z.object({ entry: CalendarEntrySchema, history: z.array(CalendarHistorySchema).max(1000) }).strict();
export const CalendarListSchema = z.object({ entries: z.array(CalendarEntrySchema).max(5000) }).strict();
export const CalendarQueryFieldsSchema = z.object({
  startsAt: InstantSchema, endsAt: InstantSchema, personId: IdSchema.toLowerCase().optional(),
  kind: z.enum(['all', 'shift', 'break', 'absence']).default('all'),
  status: z.enum(['active', 'archived', 'all']).default('active'),
}).strict();
export const CalendarQuerySchema = CalendarQueryFieldsSchema.refine(({ startsAt, endsAt }) => {
  const duration = Date.parse(endsAt) - Date.parse(startsAt);
  return duration > 0 && duration <= 366 * 24 * 60 * 60_000;
}, 'Choose a positive calendar period of up to 366 days');

/** Scheduling provenance excludes personal notes and source references, including on Crew routes. */
export const RouteCalendarEntrySchema = z.object({
  id: IdSchema, version: z.number().int().positive(), personId: IdSchema, kind: CalendarKindSchema,
  startsAt: InstantSchema, endsAt: InstantSchema,
}).strict();
export type RouteCalendarEntry = z.infer<typeof RouteCalendarEntrySchema>;
export const RouteCalendarSchema = z.object({
  mode: z.literal('shared_calendar'), participantIds: z.array(IdSchema).max(100),
  startsAt: InstantSchema, endsAt: InstantSchema.nullable(), entries: z.array(RouteCalendarEntrySchema).max(20000),
}).strict();
export type RouteCalendar = z.infer<typeof RouteCalendarSchema>;
