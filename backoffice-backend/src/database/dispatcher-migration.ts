import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class DispatcherQueue1793701400000 implements MigrationInterface {
  name = 'DispatcherQueue1793701400000';
  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name,inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Dispatcher queue migration requires a transaction');
    await runner.query(`CREATE TABLE dispatcher_case (
      case_key text PRIMARY KEY CHECK(case_key ~ '^[a-f0-9]{64}$'), version integer NOT NULL CHECK(version>0),
      owner_id uuid REFERENCES app_user(id), owner_name text,
      next_action text NOT NULL CHECK(length(next_action) BETWEEN 1 AND 2000), note text NOT NULL CHECK(length(note) BETWEEN 1 AND 2000),
      updated_at timestamptz NOT NULL, updated_by uuid NOT NULL, updated_by_name text NOT NULL,
      snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
      CHECK((owner_id IS NULL)=(owner_name IS NULL))
    );
    CREATE TABLE dispatcher_case_event (
      case_key text NOT NULL REFERENCES dispatcher_case(case_key), version integer NOT NULL CHECK(version>0),
      request_id uuid NOT NULL, request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
      payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
      PRIMARY KEY(case_key,version), UNIQUE(case_key,request_id)
    );
    CREATE INDEX dispatcher_case_owner ON dispatcher_case(owner_id);`);
  }
  down(): Promise<void> { return Promise.reject(new Error('Use a reviewed recovery procedure to preserve dispatcher coordination history')); }
}
