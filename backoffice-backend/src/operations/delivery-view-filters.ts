import { z } from 'zod';
import { IdSchema, IssueTypeSchema, ReturnRequestSchema, TextSchema, type Appointment, type Delivery, type DeliveryView } from '../domain/model';

const ReturnFilterStatusSchema = ReturnRequestSchema.shape.status.exclude(['resolved']);
const ActivityQuerySchema = z.object({
  crewId: IdSchema.optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  issueType: IssueTypeSchema.optional(),
  returnStatus: ReturnFilterStatusSchema.optional(),
});

export const deliveryActivityQueryShape = ActivityQuerySchema.shape;
export type DeliveryActivityQuery = z.infer<typeof ActivityQuerySchema>;
type ActivityView = Exclude<DeliveryView, 'inbox'>;

export function validateDeliveryActivityQuery(query: DeliveryActivityQuery & { view?: DeliveryView }, context: z.RefinementCtx) {
  const { view, crewId, dateFrom, dateTo, issueType, returnStatus } = query;
  if ((!view || view === 'inbox') && (crewId || dateFrom || dateTo || issueType || returnStatus)) {
    context.addIssue({ code: 'custom', path: ['view'], message: 'Activity filters require an operational delivery view' });
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    context.addIssue({ code: 'custom', path: ['dateTo'], message: 'End date must be on or after start date' });
  }
  if (issueType && view !== 'issues') {
    context.addIssue({ code: 'custom', path: ['issueType'], message: 'Issue type is available in the Issues view' });
  }
  if (returnStatus && view !== 'return_required') {
    context.addIssue({ code: 'custom', path: ['returnStatus'], message: 'Return status is available in the Return visit required view' });
  }
}

const count = z.number().int().positive();
export const DeliveryFilterFacetsSchema = z.object({
  crews: z.array(z.object({ id: IdSchema, name: TextSchema, count: z.number().int().nonnegative() }).strict()),
  issueTypes: z.array(z.object({ value: IssueTypeSchema, count }).strict()),
  returnStatuses: z.array(z.object({ value: ReturnFilterStatusSchema, count }).strict()),
}).strict();

type Facets = z.infer<typeof DeliveryFilterFacetsSchema>;
export type FilterCrew = Pick<Facets['crews'][number], 'id' | 'name'>;
type IssueType = z.infer<typeof IssueTypeSchema>;
type ReturnStatus = z.infer<typeof ReturnFilterStatusSchema>;

const romeDateFormatter = new Intl.DateTimeFormat('en', {
  timeZone: 'Europe/Rome', calendar: 'iso8601', year: 'numeric', month: '2-digit', day: '2-digit',
});

function romeDate(instant: number): string {
  const parts = romeDateFormatter.formatToParts(instant);
  const year = parts.find(({ type }) => type === 'year')?.value;
  const month = parts.find(({ type }) => type === 'month')?.value;
  const day = parts.find(({ type }) => type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Could not format a delivery date');
  return `${year.padStart(4, '0')}-${month}-${day}`;
}

function visitOverlapsDates(appointment: Appointment, { dateFrom, dateTo }: DeliveryActivityQuery) {
  // The visit end is exclusive. A midnight end does not occupy the following day.
  return (!dateFrom || romeDate(Date.parse(appointment.endsAt) - 1) >= dateFrom)
    && (!dateTo || romeDate(Date.parse(appointment.startsAt)) <= dateTo);
}

function visitsForView(delivery: Delivery, view: ActivityView) {
  switch (view) {
    case 'planned':
    case 'assigned':
      return delivery.appointments.filter(({ status }) => status === 'booked');
    case 'in_progress':
      return delivery.appointments.filter(({ status }) => status === 'in_progress');
    case 'completed':
      return delivery.appointments.filter(({ status }) => status === 'completed');
    default:
      return delivery.appointments.filter(({ status }) => status !== 'cancelled');
  }
}

function completionMatchesDates(completedAt: string | null, { dateFrom, dateTo }: DeliveryActivityQuery) {
  if (completedAt === null) return false;
  const date = romeDate(Date.parse(completedAt));
  return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
}

export function deliveryActivity(delivery: Delivery, view: ActivityView, query: DeliveryActivityQuery) {
  const visits = visitsForView(delivery, view);
  const hasDateFilter = query.dateFrom !== undefined || query.dateTo !== undefined;
  const matchingVisits = hasDateFilter && view !== 'completed' ? visits.filter((visit) => visitOverlapsDates(visit, query)) : visits;
  const dateMatches = !hasDateFilter || (view === 'completed'
    ? completionMatchesDates(delivery.completedAt, query)
    : matchingVisits.length > 0);

  const crews = new Map<string, string>();
  for (const visit of matchingVisits) {
    for (const { crewId, crewName } of visit.assignments) crews.set(crewId.toLowerCase(), crewName);
  }
  const issueTypes = new Set<IssueType>();
  if (view === 'issues') {
    for (const issue of delivery.issues) if (issue.status === 'open') issueTypes.add(issue.type);
  }
  const returnStatuses = new Set<ReturnStatus>();
  if (view === 'return_required') {
    for (const request of delivery.returnRequests) if (request.status !== 'resolved') returnStatuses.add(request.status);
  }
  return {
    crews, issueTypes, returnStatuses, dateMatches,
    crewMatches: query.crewId === undefined || crews.has(query.crewId.toLowerCase()),
    issueMatches: query.issueType === undefined || issueTypes.has(query.issueType),
    returnMatches: query.returnStatus === undefined || returnStatuses.has(query.returnStatus),
  };
}

function addCounts<Key>(counts: Map<Key, number>, values: ReadonlySet<Key>) {
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
}

export function deliveryActivityFacets(activities: readonly ReturnType<typeof deliveryActivity>[],
  directory: readonly FilterCrew[]): Facets {
  const crews = new Map<string, Facets['crews'][number]>(directory.map(({ id, name }) => [id.toLowerCase(), { id, name, count: 0 }]));
  const issueTypes = new Map<IssueType, number>();
  const returnStatuses = new Map<ReturnStatus, number>();

  for (const activity of activities) {
    if (!activity.dateMatches) continue;
    if (activity.issueMatches && activity.returnMatches) {
      for (const [id, name] of activity.crews) {
        const existing = crews.get(id);
        if (existing) existing.count++;
        else crews.set(id, { id, name, count: 1 });
      }
    }
    if (activity.crewMatches && activity.returnMatches) addCounts(issueTypes, activity.issueTypes);
    if (activity.crewMatches && activity.issueMatches) addCounts(returnStatuses, activity.returnStatuses);
  }

  return {
    crews: [...crews.values()].sort((left, right) => left.name.localeCompare(right.name, 'en') || left.id.localeCompare(right.id)),
    issueTypes: [...issueTypes].map(([value, count]) => ({ value, count })),
    returnStatuses: [...returnStatuses].map(([value, count]) => ({ value, count })),
  };
}
