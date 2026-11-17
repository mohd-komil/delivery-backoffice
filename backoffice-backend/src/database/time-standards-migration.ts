import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class TimeStandards1793701800000 implements MigrationInterface {
  name = 'TimeStandards1793701800000';
  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name,inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Work-time standards migration requires a transaction');
    await runner.query(`CREATE TABLE planning_time_standard (
      id uuid PRIMARY KEY, version integer NOT NULL CHECK(version>0),
      data jsonb NOT NULL CHECK(jsonb_typeof(data)='object')
    );
    CREATE TABLE planning_time_standard_event (
      standard_id uuid NOT NULL REFERENCES planning_time_standard(id), version integer NOT NULL CHECK(version>0),
      payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), PRIMARY KEY(standard_id,version)
    );`);
  }
  down(): Promise<void> { return Promise.reject(new Error('Use a reviewed recovery procedure to preserve work-time standard history')); }
}
