import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class RouteDraft1793700700000 implements MigrationInterface {
  name = 'RouteDraft1793700700000';

  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name, inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Run the route draft migration inside a transaction');
    await runner.query(`CREATE TABLE route_draft (
      id uuid PRIMARY KEY,
      version integer NOT NULL CHECK (version > 0),
      data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
      create_fingerprint text NOT NULL CHECK (create_fingerprint ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX route_draft_updated ON route_draft(updated_at DESC, id);`);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use a reviewed recovery procedure to preserve route drafts'));
  }
}
