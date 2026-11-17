import { z } from 'zod';
import { IdSchema, InstantSchema, OperatorSnapshotSchema, ServiceTypeSchema, SourceItemSchema, WorkTimeRatesSchema } from '../domain/model';
import { requiredWork } from '../domain/rules';

const Explanation = z.string().trim().max(2000);
export const TimeStandardFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200), service: ServiceTypeSchema,
  unit: z.string().trim().min(1).max(80), category: z.string().trim().min(1).max(200).nullable(),
  rates: WorkTimeRatesSchema, basis: z.enum(['elapsed_team_minutes', 'person_minutes', 'unspecified']),
  assumptions: Explanation, exclusions: Explanation, examples: Explanation, sourceReference: Explanation,
  status: z.enum(['draft', 'confirmed']), enabled: z.boolean(),
}).strict().superRefine((value, context) => {
  const amounts = requiredWork(value.service, 1);
  const required = {
    deliveryMinutesPerUnit: amounts.deliveredMilli > 0,
    installationMinutesPerUnit: amounts.installedMilli > 0,
    collectionMinutesPerUnit: amounts.collectedMilli > 0,
  };
  for (const rate of WorkTimeRatesSchema.keyof().options) {
    if (!required[rate] && value.rates[rate] !== null) context.addIssue({ code: 'custom', path: ['rates', rate], message: 'This operation is not part of the selected service' });
    if (value.status === 'confirmed' && required[rate] && value.rates[rate] === null) context.addIssue({ code: 'custom', path: ['rates', rate], message: 'Confirm a rate for every required operation' });
  }
  if (value.status === 'confirmed') {
    for (const field of ['sourceReference', 'assumptions'] as const) {
      if (!value[field]) context.addIssue({ code: 'custom', path: [field], message: 'Confirmation requires a source and assumptions' });
    }
    if (value.basis === 'unspecified') context.addIssue({ code: 'custom', path: ['basis'], message: 'Confirm the meaning of the time estimate' });
  }
});
export const TimeStandardSchema = TimeStandardFieldsSchema.safeExtend({
  id: IdSchema, version: z.number().int().positive(), updatedAt: InstantSchema, updatedBy: OperatorSnapshotSchema,
});
export type TimeStandard = z.infer<typeof TimeStandardSchema>;
export const CreateTimeStandardSchema = TimeStandardFieldsSchema.safeExtend({ requestId: IdSchema.toLowerCase(), reason: Explanation.min(1) });
export const UpdateTimeStandardSchema = CreateTimeStandardSchema.safeExtend({ version: z.number().int().positive() });
export const TimeStandardEventSchema = z.object({
  version: z.number().int().positive(), at: InstantSchema, actor: OperatorSnapshotSchema,
  reason: Explanation.min(1), before: TimeStandardSchema.nullable(), after: TimeStandardSchema,
}).strict();
export const TimeStandardDetailSchema = z.object({ item: TimeStandardSchema, history: z.array(TimeStandardEventSchema).max(1000) }).strict();
export const ApplyTimeStandardSchema = z.object({
  version: z.number().int().positive(), requestId: IdSchema.toLowerCase(), sourceLineId: SourceItemSchema.shape.sourceLineId,
  standardId: IdSchema.toLowerCase(), standardVersion: z.number().int().positive(), reason: Explanation.min(1),
}).strict();
