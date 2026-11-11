import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class DestinationEntrance1793700800000 implements MigrationInterface {
  name = 'DestinationEntrance1793700800000';

  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name, inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Run the destination entrance migration inside a transaction');
    await runner.query(`CREATE TABLE destination_entrance (
      source_instance text NOT NULL,
      source_customer_id integer NOT NULL CHECK (source_customer_id > 0),
      address_key text NOT NULL CHECK (address_key ~ '^[a-f0-9]{64}$'),
      latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
      longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
      version integer NOT NULL CHECK (version > 0),
      confirmed_at timestamptz NOT NULL DEFAULT now(),
      confirmed_by_id uuid NOT NULL,
      confirmed_by_name text NOT NULL,
      PRIMARY KEY (source_instance, source_customer_id, address_key)
    );`);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use a reviewed recovery procedure to preserve confirmed entrances'));
  }
}
