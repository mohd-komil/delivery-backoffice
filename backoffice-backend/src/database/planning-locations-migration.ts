import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

/** Historical seed values are fixed here; editing the runtime catalogue must never rewrite this migration. */
const demoPoints = [
  { id: 'demo-start-catania', name: 'Catania · Demo start · Orto Botanico', latitude: 37.5154798, longitude: 15.0834923, city: 'Catania' },
  { id: 'demo-start-messina', name: 'Messina · Demo start · Palazzo Zanca', latitude: 38.1939931, longitude: 15.5555215, city: 'Messina' },
  { id: 'warehouse-milano', name: 'Milano · Demo depot', latitude: 45.492, longitude: 9.130, city: 'Milano' },
  { id: 'warehouse-monza', name: 'Monza · Demo depot', latitude: 45.605, longitude: 9.252, city: 'Monza' },
];

export class PlanningLocations1793701600000 implements MigrationInterface {
  name = 'PlanningLocations1793701600000';
  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name,inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Planning locations migration requires a transaction');
    await runner.query(`CREATE TABLE planning_location (
      id text PRIMARY KEY CHECK(id ~ '^[a-z0-9][a-z0-9-]{0,79}$'), version integer NOT NULL CHECK(version>0),
      data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'), CHECK(data->>'id'=id), CHECK((data->>'version')::integer=version)
    );
    CREATE TABLE planning_location_event (
      location_id text NOT NULL REFERENCES planning_location(id), version integer NOT NULL CHECK(version>0),
      payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), PRIMARY KEY(location_id,version)
    );`);
    for (const { id, name, latitude, longitude, city } of demoPoints) {
      const data = { id, version: 1, name, kind: 'other', address: { street: '', city, province: '', postalCode: '', country: 'IT' },
        point: { latitude, longitude }, unloadingEntrance: null, coordinateSource: 'public_demo', verification: 'unverified', enabled: true, demo: true,
        updatedAt: '2026-11-13T00:00:00.000Z', updatedBy: null, confirmedAt: null, confirmedBy: null };
      await runner.query('INSERT INTO planning_location(id,version,data) VALUES($1,1,$2::jsonb)', [id, JSON.stringify(data)]);
      await runner.query('INSERT INTO planning_location_event(location_id,version,payload) VALUES($1,1,$2::jsonb)', [id, JSON.stringify({ version: 1,
        action: 'seeded', reason: 'Preserved existing demonstration reference point; not a confirmed company warehouse', at: data.updatedAt, actor: null, snapshot: data })]);
    }
  }
  down(): Promise<void> { return Promise.reject(new Error('Use a reviewed recovery procedure to preserve planning location history')); }
}
