import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class RouteLifecycle1793701200000 implements MigrationInterface {
  name = 'RouteLifecycle1793701200000';
  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name,inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Route lifecycle migration requires a transaction');
    await runner.query(`ALTER TABLE route_publication ADD COLUMN runtime jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(runtime)='object');
      ALTER TABLE route_stop DROP CONSTRAINT route_stop_route_id_sequence_key;
      ALTER TABLE route_stop ADD CONSTRAINT route_stop_route_id_sequence_key UNIQUE(route_id,sequence) DEFERRABLE INITIALLY IMMEDIATE;
      CREATE TABLE route_command (route_id uuid NOT NULL REFERENCES route_publication(id), request_id uuid NOT NULL,
        fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), result_version integer NOT NULL CHECK(result_version>0),
        PRIMARY KEY(route_id,request_id));
      CREATE TABLE route_revision (route_id uuid NOT NULL REFERENCES route_publication(id), version integer NOT NULL CHECK(version>0),
        status text NOT NULL, data jsonb NOT NULL, runtime jsonb NOT NULL,
        actor_id uuid NOT NULL, actor_name text NOT NULL, action text NOT NULL, reason text,
        at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(route_id,version));`);
  }
  down(): Promise<void> { return Promise.reject(new Error('Use a reviewed recovery procedure to preserve route operation history')); }
}
