import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class PlanningCalendar1793701700000 implements MigrationInterface {
  name = 'PlanningCalendar1793701700000';
  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name,inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Planning calendar migration requires a transaction');
    await runner.query(`CREATE TABLE planning_calendar_entry (
      id uuid PRIMARY KEY, version integer NOT NULL CHECK(version>0), person_id uuid NOT NULL REFERENCES person(id),
      kind text NOT NULL CHECK(kind IN ('shift','break','absence')),
      starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
      archived boolean NOT NULL, data jsonb NOT NULL CHECK(jsonb_typeof(data)='object')
    );
    CREATE INDEX planning_calendar_person_interval ON planning_calendar_entry(person_id,starts_at,ends_at) WHERE NOT archived;
    CREATE INDEX planning_calendar_interval ON planning_calendar_entry(starts_at,ends_at);
    CREATE TABLE planning_calendar_event (
      entry_id uuid NOT NULL REFERENCES planning_calendar_entry(id), version integer NOT NULL CHECK(version>0),
      payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), PRIMARY KEY(entry_id,version)
    );`);
  }
  down(): Promise<void> { return Promise.reject(new Error('Use a reviewed recovery procedure to preserve participant scheduling history')); }
}
