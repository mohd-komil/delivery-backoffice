import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

/** Additive physical-vehicle catalogue and derived reservations; no existing history or JSON is rewritten. */
export class VehicleTransport1793700400000 implements MigrationInterface {
  name='VehicleTransport1793700400000';
  async up(runner:QueryRunner):Promise<void> {
    const target:unknown=await runner.query('SELECT current_database() AS name,inet_server_port() AS port');
    z.array(z.object({name:z.enum(['delivery_backoffice','delivery_backoffice_test']),port:z.literal(55432)})).length(1).parse(target);
    if(!runner.isTransactionActive) throw new Error('Run the vehicle migration inside the reviewed migration transaction');
    await runner.query('SELECT pg_advisory_xact_lock(7041001)');
    await runner.query(`CREATE TABLE vehicle (
      id uuid PRIMARY KEY,version integer NOT NULL DEFAULT 1 CHECK(version>0),
      ownership text NOT NULL CHECK(ownership IN ('company','external')),
      name text NOT NULL CHECK(name=btrim(name) AND length(name) BETWEEN 1 AND 200),
      plate text NOT NULL CHECK(plate=upper(btrim(plate)) AND length(plate) BETWEEN 1 AND 32 AND plate ~ '^[A-Z0-9][A-Z0-9 -]*$'),
      provider_name text CHECK(provider_name IS NULL OR (provider_name=btrim(provider_name) AND length(provider_name) BETWEEN 1 AND 200)),
      provider_contact text CHECK(provider_contact IS NULL OR (provider_contact=btrim(provider_contact) AND length(provider_contact) BETWEEN 1 AND 500)),
      operational_status text NOT NULL CHECK(operational_status IN ('available','maintenance','out_of_service')),
      enabled boolean NOT NULL DEFAULT true,notes text CHECK(notes IS NULL OR (notes=btrim(notes) AND length(notes)<=4000)),
      CHECK((ownership='external' AND provider_name IS NOT NULL) OR (ownership='company' AND provider_name IS NULL AND provider_contact IS NULL))
    );
    CREATE UNIQUE INDEX vehicle_plate_unique ON vehicle(upper(plate));
    CREATE TABLE transport_reservation (
      allocation_id uuid NOT NULL,appointment_id uuid NOT NULL REFERENCES appointment(id),
      resource text NOT NULL CHECK(resource ~ '^(vehicle|person):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
      starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
      PRIMARY KEY(allocation_id,resource),CHECK(ends_at>starts_at AND ends_at-starts_at<=interval '45 days')
    );
    CREATE INDEX transport_reservation_resource ON transport_reservation(resource,starts_at,ends_at);
    CREATE INDEX transport_reservation_appointment ON transport_reservation(appointment_id);`);
  }
  down():Promise<void> {return Promise.reject(new Error('Vehicle and transport history has no automatic destructive rollback; use a reviewed recovery procedure'));}
}
