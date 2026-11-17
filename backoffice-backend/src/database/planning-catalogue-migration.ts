import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class PlanningCatalogueCommands1793701500000 implements MigrationInterface {
  name = 'PlanningCatalogueCommands1793701500000';
  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name,inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Planning catalogue migration requires a transaction');
    await runner.query(`CREATE TABLE planning_catalogue_command (
      scope text NOT NULL CHECK(length(scope) BETWEEN 1 AND 80), record_id text NOT NULL CHECK(length(record_id) BETWEEN 1 AND 80),
      request_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
      response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(scope,record_id,request_id)
    );`);
  }
  down(): Promise<void> { return Promise.reject(new Error('Use a reviewed recovery procedure to preserve planning command history')); }
}
