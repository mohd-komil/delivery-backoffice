import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { PERSON_NAME_SQL } from '../database/person-name';
import { IdSchema, type OperatorActor } from '../domain/model';
import { DomainError } from '../domain/rules';
import { DeliveryStore } from '../operations/store';
import type { RouteDraftInput, RouteTimeline } from '../routing/contracts';
import { catalogueCommand } from './catalogue-command';
import {
  CalendarCreateSchema, CalendarDetailSchema, CalendarEntrySchema, CalendarHistorySchema, CalendarQuerySchema, CalendarUpdateSchema,
  RouteCalendarEntrySchema, type CalendarEntry, type RouteCalendarEntry, type RouteCalendar,
} from './calendar-contracts';

function overlaps(entry: { startsAt: string; endsAt: string }, startsAt: string, endsAt: string) {
  return Date.parse(entry.startsAt) < Date.parse(endsAt) && Date.parse(entry.endsAt) > Date.parse(startsAt);
}

/** Pure projection reused when the suggested order changes the return time. */
export function resolveRouteCalendar(input: RouteDraftInput, timeline: Pick<RouteTimeline, 'departAt' | 'returnAt'>, entries: readonly RouteCalendarEntry[]) {
  if (input.planning?.availabilityMode !== 'shared_calendar') return { input, calendar: undefined };
  const ids = [...input.planning.participantIds].sort();
  const relevant = entries.filter((entry) => ids.includes(entry.personId)
    && (timeline.returnAt ? overlaps(entry, timeline.departAt, timeline.returnAt) : Date.parse(entry.endsAt) > Date.parse(timeline.departAt)))
    .sort((a, b) => a.personId.localeCompare(b.personId) || a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  const calendar: RouteCalendar = { mode: 'shared_calendar', participantIds: ids, startsAt: timeline.departAt, endsAt: timeline.returnAt, entries: relevant };
  return {
    input: { ...input, planning: { ...input.planning, participantAvailability: ids.map((participantId) => ({
      participantId,
      workingIntervals: relevant.filter((entry) => entry.personId === participantId && entry.kind === 'shift').map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
      unavailableIntervals: relevant.flatMap((entry) => entry.personId === participantId && entry.kind !== 'shift'
        ? [{ startsAt: entry.startsAt, endsAt: entry.endsAt, kind: entry.kind }] : []),
    })) } }, calendar,
  };
}

/** Wider than every possible order of these bounded work/travel legs, including customer-window waiting. */
function routeCalendarHorizon(input: RouteDraftInput) {
  const latest = Math.max(Date.parse(input.departAt), ...input.stops.flatMap(({ customerWindow }) =>
    customerWindow?.kind === 'arrival' || customerWindow?.kind === 'work_end' ? [Date.parse(customerWindow.endsAt)] : []));
  return new Date(latest + (input.stops.length * 2 + 1) * 1440 * 60_000).toISOString();
}

@Injectable()
export class PlanningCalendar {
  constructor(@Inject(DeliveryStore) private readonly store: DeliveryStore) {}

  async list(input: unknown) {
    const query = CalendarQuerySchema.parse(input);
    const records = await rows(this.store.db.source.manager, z.object({ data: CalendarEntrySchema, personName: z.string() }),
      `SELECT e.data,${PERSON_NAME_SQL} AS "personName" FROM planning_calendar_entry e JOIN person p ON p.id=e.person_id
       WHERE e.starts_at<$2 AND e.ends_at>$1 AND ($3::uuid IS NULL OR e.person_id=$3)
       AND ($4='all' OR e.kind=$4) AND ($5='all' OR e.archived=($5='archived'))
       ORDER BY e.starts_at,e.person_id,e.id LIMIT 5001`, [query.startsAt, query.endsAt, query.personId ?? null, query.kind, query.status]);
    if (records.length > 5000) throw new DomainError('CALENDAR_LIMIT', 'Narrow the participant calendar period or filter; more than 5000 entries match');
    return { entries: records.map(({ data, personName }) => ({ ...data, personName })) };
  }

  async detail(id: string, manager?: EntityManager): Promise<z.infer<typeof CalendarDetailSchema>> {
    if (!manager) return this.store.db.source.transaction('REPEATABLE READ', (scoped) => this.detail(id, scoped));
    const entry = await this.requireEntry(id, manager);
    const history = await rows(manager, z.object({ payload: CalendarHistorySchema }),
      'SELECT payload FROM planning_calendar_event WHERE entry_id=$1 ORDER BY version DESC LIMIT 1001', [id]);
    if (history.length > 1000) throw new DomainError('CALENDAR_HISTORY_LIMIT', 'Calendar entry history exceeds the current 1000-revision display limit');
    return { entry, history: history.map(({ payload }) => payload) };
  }

  async save(id: string | null, input: unknown, actor: OperatorActor) {
    const raw = id === null ? CalendarCreateSchema.parse(input) : CalendarUpdateSchema.parse(input);
    const command = { ...raw, startsAt: new Date(raw.startsAt).toISOString(), endsAt: new Date(raw.endsAt).toISOString() };
    const entryId = id === null ? command.requestId : IdSchema.parse(id).toLowerCase();
    return this.store.db.source.transaction((manager) => catalogueCommand(manager,
      { scope: 'participant_calendar', recordId: entryId, requestId: command.requestId, actor, action: id === null ? 'create' : 'update', input: command },
      CalendarDetailSchema, async () => {
        const previous = id === null ? null : await this.requireEntry(entryId, manager);
        if (previous && (!('version' in command) || command.version !== previous.version)) throw new DomainError('CALENDAR_VERSION_CHANGED', 'The calendar entry changed. Refresh and review your changes.');
        if (previous && previous.personId !== command.personId) throw new DomainError('CALENDAR_PERSON_CHANGED', 'An entry belongs to its original participant; archive it and create a new entry for another participant', 400);
        const [person] = await rows(manager, z.object({ name: z.string() }), `SELECT ${PERSON_NAME_SQL} AS name FROM person p WHERE p.id=$1`, [command.personId]);
        if (!person) throw new NotFoundException('Participant not found');
        const archived = 'archived' in command ? command.archived : false;
        const entry = CalendarEntrySchema.parse({ id: entryId, version: (previous?.version ?? 0) + 1, personId: command.personId, personName: person.name,
          kind: command.kind, startsAt: command.startsAt, endsAt: command.endsAt, timeZone: command.timeZone,
          sourceReference: command.sourceReference, note: command.note, archived,
          updatedAt: new Date().toISOString(), updatedBy: { id: actor.id, name: actor.name } });
        if (entry.version > 1000) throw new DomainError('CALENDAR_HISTORY_LIMIT', 'Archive this entry and create a replacement after 1000 revisions');
        if (previous) await manager.query(`UPDATE planning_calendar_entry SET version=$2,kind=$3,starts_at=$4,ends_at=$5,archived=$6,data=$7::jsonb WHERE id=$1`,
          [entryId, entry.version, entry.kind, entry.startsAt, entry.endsAt, entry.archived, JSON.stringify(entry)]);
        else await manager.query(`INSERT INTO planning_calendar_entry(id,version,person_id,kind,starts_at,ends_at,archived,data) VALUES($1,1,$2,$3,$4,$5,false,$6::jsonb)`,
          [entryId, entry.personId, entry.kind, entry.startsAt, entry.endsAt, JSON.stringify(entry)]);
        const action = previous === null ? 'created' : previous.archived !== archived ? archived ? 'archived' : 'restored' : 'updated';
        const event = CalendarHistorySchema.parse({ version: entry.version, action, reason: command.reason, at: entry.updatedAt, actor: entry.updatedBy, entry });
        await manager.query('INSERT INTO planning_calendar_event(entry_id,version,payload) VALUES($1,$2,$3::jsonb)', [entryId, entry.version, JSON.stringify(event)]);
        await this.store.audit(manager, actor, `planning.calendar_${action}`, { entryId, personId: entry.personId, version: entry.version, reason: command.reason });
        return this.detail(entryId, manager);
      }));
  }

  async routeEntries(manager: EntityManager, input: RouteDraftInput, returnAt?: string | null): Promise<RouteCalendarEntry[]> {
    if (input.planning?.availabilityMode !== 'shared_calendar' || !input.planning.participantIds.length) return [];
    const horizon = routeCalendarHorizon(input);
    const until = returnAt && Date.parse(returnAt) > Date.parse(horizon) ? returnAt : horizon;
    const records = await rows(manager, z.object({ data: CalendarEntrySchema }), `SELECT data FROM planning_calendar_entry
      WHERE person_id=ANY($1::uuid[]) AND NOT archived AND starts_at<$3 AND ends_at>$2
      ORDER BY person_id,starts_at,id LIMIT 20001`, [input.planning.participantIds, input.departAt, until]);
    if (records.length > 20000) throw new DomainError('CALENDAR_ROUTE_LIMIT', 'The selected route calendar exceeds 20000 entries; narrow the route period');
    return records.map(({ data }) => RouteCalendarEntrySchema.parse({ id: data.id, version: data.version, personId: data.personId,
      kind: data.kind, startsAt: data.startsAt, endsAt: data.endsAt }));
  }

  async currentSnapshot(manager: EntityManager, input: RouteDraftInput, timeline: Pick<RouteTimeline, 'departAt' | 'returnAt'>) {
    return resolveRouteCalendar(input, timeline, await this.routeEntries(manager, input, timeline.returnAt)).calendar;
  }

  private async requireEntry(id: string, manager: EntityManager): Promise<CalendarEntry> {
    const [row] = await rows(manager, z.object({ data: CalendarEntrySchema }), 'SELECT data FROM planning_calendar_entry WHERE id=$1', [id]);
    if (!row) throw new NotFoundException('Calendar entry not found');
    return row.data;
  }
}
