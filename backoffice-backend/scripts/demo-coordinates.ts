import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createApp } from '../src/app';
import { rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { DeliverySchema, GeoPointSchema, type Delivery, type OperatorActor } from '../src/domain/model';
import { Identity } from '../src/identity/identity';
import { DeliveryStore } from '../src/operations/store';
import { importedDemoSourceInstance, matchDemoAddress } from './demo-fixtures';

const auditAction = 'demo.coordinates_added';
const AccountsSchema = z.object({ operator: z.object({ email: z.string().email(), password: z.string().min(1).max(256) }) });

// Artificial points for the existing fictional Via Dimostrativa addresses.
// These are teaching coordinates, not geocoded or confirmed unloading entrances.
const customerPoints = new Map<number, z.infer<typeof GeoPointSchema>>([
  [1, { latitude: 37.571, longitude: 15.109 }],
  [2, { latitude: 38.1938, longitude: 15.554 }],
  [3, { latitude: 37.514, longitude: 15.087 }],
  [4, { latitude: 38.208, longitude: 15.566 }],
  [5, { latitude: 37.548, longitude: 15.102 }],
  [6, { latitude: 38.232, longitude: 15.578 }],
  [7, { latitude: 37.607, longitude: 15.13 }],
  [8, { latitude: 38.27, longitude: 15.6 }],
  [9, { latitude: 37.5079, longitude: 15.083 }],
  [10, { latitude: 38.31, longitude: 15.62 }],
  [11, { latitude: 37.669, longitude: 15.165 }],
]);

type SkipReason = 'fixture_changed' | 'existing_point' | 'confirmed_entrance' | 'incomplete_address';
export type DemoCoordinatesSummary = {
  updated: { id: string; pickingName: string; point: z.infer<typeof GeoPointSchema> }[];
  skipped: { id: string; pickingName: string; reason: SkipReason }[];
};

function fixturePoint(sourceId: number, delivery: Delivery):
  { point: z.infer<typeof GeoPointSchema> } | { reason: 'fixture_changed' | 'incomplete_address' } {
  const fixture = matchDemoAddress(sourceId, delivery);
  if ('reason' in fixture) return fixture;
  const point = customerPoints.get(fixture.customerId);
  return point ? { point: GeoPointSchema.parse(point) } : { reason: 'incomplete_address' } as const;
}

/** Fill only verified, missing synthetic reference points; preserve all operational data. */
export async function seedDemoCoordinates(store: DeliveryStore, principal: OperatorActor): Promise<DemoCoordinatesSummary> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('Demo coordinates cannot run in production mode');
  return store.db.source.transaction(async (manager) => {
    const target = await rows(manager, z.object({
      name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432),
    }), 'SELECT current_database() AS name, inet_server_port() AS port');
    if (target.length !== 1) throw new Error('Expected one isolated local database');
    await manager.query('SELECT pg_advisory_xact_lock(7041001)');
    const candidates = await rows(manager, z.object({ id: z.string().uuid(), sourceId: z.number().int(), version: z.number().int(), data: DeliverySchema }),
      `SELECT id, source_id AS "sourceId", version, data FROM delivery
       WHERE source_instance=$1 AND source_id BETWEEN 1 AND 20 ORDER BY source_id FOR UPDATE`, [importedDemoSourceInstance]);
    const summary: DemoCoordinatesSummary = { updated: [], skipped: [] };
    for (const { id, sourceId, version, data: delivery } of candidates) {
      if (delivery.id !== id || delivery.version !== version) throw new Error('Delivery identity or version mismatch; demo coordinates were not applied');
      const base = { id: delivery.id, pickingName: delivery.source.pickingName };
      const fixture = fixturePoint(sourceId, delivery);
      if ('reason' in fixture) {
        summary.skipped.push({ ...base, reason: fixture.reason });
        continue;
      }
      if (delivery.routePoint !== undefined) {
        summary.skipped.push({ ...base, reason: 'existing_point' });
        continue;
      }
      const addressKey = destinationAddressKey(delivery.source.customer);
      const entrance = await rows(manager, z.object({ exists: z.boolean() }),
        `SELECT EXISTS (SELECT 1 FROM destination_entrance
         WHERE source_instance=$1 AND source_customer_id=$2 AND address_key=$3) AS exists`,
        [importedDemoSourceInstance, delivery.source.customer.id, addressKey]);
      if (entrance[0]?.exists) {
        summary.skipped.push({ ...base, reason: 'confirmed_entrance' });
        continue;
      }
      // Update only these two JSON fields so source snapshots, results, history and unknown fields remain untouched.
      await manager.query(`UPDATE delivery SET version=version+1,
        data=jsonb_set(jsonb_set(data,'{routePoint}',$2::jsonb),'{version}',to_jsonb(version+1)) WHERE id=$1`,
      [delivery.id, JSON.stringify(fixture.point)]);
      await store.audit(manager, principal, auditAction, {
        synthetic: true, addressKey, pointSource: 'synthetic_fixture', version: version + 1,
      }, delivery.id);
      summary.updated.push({ ...base, point: fixture.point });
    }
    return summary;
  });
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply' || process.env['NODE_ENV'] === 'production') {
    throw new Error('Use demo-coordinates.ts --apply only on the local synthetic stand');
  }
  const app = await createApp(true);
  let request: { headers: { cookie: string } } | undefined;
  try {
    await app.init();
    const raw: unknown = JSON.parse(await readFile('.local/demo-accounts.json', 'utf8'));
    const account = AccountsSchema.parse(raw).operator;
    const identity = app.get(Identity);
    const login = await identity.login(account);
    request = { headers: { cookie: `backoffice_session=${login.token}` } };
    const principal = await identity.authenticate(request);
    const summary = await seedDemoCoordinates(app.get(DeliveryStore), principal);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    try {
      if (request) await app.get(Identity).logout(request);
    } finally {
      await app.close();
    }
  }
}

if (require.main === module) void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Demo coordinate population failed');
  process.exitCode = 1;
});
