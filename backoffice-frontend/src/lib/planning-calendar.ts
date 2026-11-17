import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });
const actor = z.object({ id: z.uuid(), name: z.string() });
export const planningCalendarKindSchema = z.enum(['shift', 'break', 'absence']);
export const planningCalendarFieldsSchema = z.object({ personId: z.uuid(), kind: planningCalendarKindSchema,
  startsAt: instant, endsAt: instant, timeZone: z.literal('Europe/Rome'), sourceReference: z.string().trim().min(1).max(2000), note: z.string().trim().max(2000),
}).strict().refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), 'End must follow start.');
export const planningCalendarEntrySchema = planningCalendarFieldsSchema.safeExtend({
  id: z.uuid(), version: z.number().int().positive(), personName: z.string(), archived: z.boolean(), updatedAt: instant, updatedBy: actor,
});
export const planningCalendarSchema = z.object({ entries: z.array(planningCalendarEntrySchema) });
export const planningCalendarDetailSchema = z.object({ entry: planningCalendarEntrySchema, history: z.array(z.object({
  version: z.number().int().positive(), action: z.string(), reason: z.string(), at: instant, actor, entry: planningCalendarEntrySchema,
})).max(1000) });
export type PlanningCalendarEntry = z.infer<typeof planningCalendarEntrySchema>;
export const routeCalendarSchema = z.object({ mode: z.literal('shared_calendar'), participantIds: z.array(z.uuid()).max(100),
  startsAt: instant, endsAt: instant.nullable(), entries: z.array(z.object({ id: z.uuid(), version: z.number().int().positive(), personId: z.uuid(),
    kind: planningCalendarKindSchema, startsAt: instant, endsAt: instant })).max(20000) });
