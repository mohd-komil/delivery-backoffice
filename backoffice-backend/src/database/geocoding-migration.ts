import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class AddressGeocoding1793701300000 implements MigrationInterface {
  name = 'AddressGeocoding1793701300000';

  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name, inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Run address geocoding migration inside a transaction');
    await runner.query(`CREATE TABLE address_geocoding (
      source_instance text NOT NULL,
      address_key text NOT NULL CHECK (address_key ~ '^[a-f0-9]{64}$'),
      provider text NOT NULL CHECK (provider='geoapify'),
      status text NOT NULL CHECK (status IN ('pending','accepted','review_required','not_found','failed')),
      version integer NOT NULL CHECK (version > 0),
      candidate jsonb,
      acceptance text CHECK (acceptance IN ('automatic','operator')),
      reason text,
      request_token uuid,
      lease_until timestamptz,
      retry_after timestamptz,
      accepted_by_id uuid,
      accepted_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source_instance,address_key),
      CHECK ((status IN ('accepted','review_required'))=(candidate IS NOT NULL)),
      CHECK (candidate IS NULL OR jsonb_typeof(candidate)='object'),
      CHECK ((status='accepted')=(acceptance IS NOT NULL)),
      CHECK ((status='pending')=(request_token IS NOT NULL AND lease_until IS NOT NULL))
    );
    CREATE TABLE geocoding_budget (
      provider text PRIMARY KEY CHECK (provider='geoapify'),
      budget_day date NOT NULL,
      used integer NOT NULL CHECK (used >= 0),
      next_request_at timestamptz NOT NULL
    );`);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use a reviewed recovery procedure to preserve geocoded addresses and quota history'));
  }
}
