import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

/** Additive publication ownership; existing drafts, appointments and ledgers are not rewritten. */
export class RoutePublication1793701100000 implements MigrationInterface {
  name = 'RoutePublication1793701100000';

  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name, inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Run the publication migration inside a transaction');
    await runner.query(`CREATE TABLE route_publication (
      id uuid PRIMARY KEY REFERENCES route_draft(id), version integer NOT NULL CHECK(version > 0),
      draft_version integer NOT NULL CHECK(draft_version > 0),
      status text NOT NULL CHECK(status IN ('published','in_progress','returning','returned','closed','cancelled')),
      data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
      request_id uuid UNIQUE NOT NULL, command_fingerprint text NOT NULL CHECK(command_fingerprint ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE route_stop (
      id uuid PRIMARY KEY, route_id uuid NOT NULL REFERENCES route_publication(id),
      appointment_id uuid NOT NULL REFERENCES appointment(id), delivery_id uuid NOT NULL REFERENCES delivery(id),
      sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 30),
      source text NOT NULL CHECK(source IN ('created','attached')), active boolean NOT NULL DEFAULT true,
      provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'), UNIQUE(route_id,sequence)
    );
    CREATE UNIQUE INDEX route_stop_active_appointment ON route_stop(appointment_id) WHERE active;
    CREATE INDEX route_stop_delivery ON route_stop(delivery_id);
    CREATE TABLE route_reservation (
      route_id uuid NOT NULL REFERENCES route_publication(id), resource text NOT NULL,
      starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
      buffer_minutes integer NOT NULL CHECK(buffer_minutes BETWEEN 0 AND 240),
      PRIMARY KEY(route_id,resource), CHECK(ends_at>starts_at)
    );
    CREATE INDEX route_reservation_resource ON route_reservation(resource,starts_at,ends_at);`);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use a reviewed recovery procedure to preserve published routes and visit history'));
  }
}
