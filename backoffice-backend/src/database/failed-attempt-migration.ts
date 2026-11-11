import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class FailedAttempt1793700600000 implements MigrationInterface {
  name = 'FailedAttempt1793700600000';

  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name, inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Run the failed attempt migration inside a transaction');
    await runner.query('SELECT pg_advisory_xact_lock(7041001)');
    await runner.query(`ALTER TABLE appointment
      DROP CONSTRAINT appointment_status_check,
      ADD CONSTRAINT appointment_status_check CHECK (status IN ('booked','in_progress','completed','cancelled','failed'))`);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use a reviewed recovery procedure to preserve recorded failed attempts'));
  }
}
