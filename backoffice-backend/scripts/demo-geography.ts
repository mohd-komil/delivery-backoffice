import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createApp } from '../src/app';
import { rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { AddressGeographySchema } from '../src/domain/delivery-geography';
import { DeliverySchema, type OperatorActor } from '../src/domain/model';
import { Identity } from '../src/identity/identity';
import { DeliveryStore } from '../src/operations/store';
import { importedDemoSourceInstance, matchDemoAddress } from './demo-fixtures';

const auditAction = 'demo.geography_added';
const AccountsSchema = z.object({ operator: z.object({ email: z.string().email(), password: z.string().min(1).max(256) }) });

// CAP values are assigned to fictional Via Dimostrativa addresses for filter testing.
// They are not a geocoding result or a claim that these streets exist in those postal areas.
const postalCodesByCustomer = new Map([
  [1, '95121'], [2, '98121'], [3, '95125'], [4, '98122'], [5, '95121'], [6, '98121'],
  [7, '95125'], [8, '98122'], [9, '95121'], [10, '98121'], [11, '95125'],
]);

export type DemoGeographySummary = {
  updated: { id: string; pickingName: string; geography: z.infer<typeof AddressGeographySchema> }[];
  skipped: { id: string; pickingName: string; reason: 'fixture_changed' | 'incomplete_address' | 'existing_geography' }[];
};

/** Add only missing address-bound teaching metadata; never rewrite source or dispatcher data. */
export async function seedDemoGeography(store: DeliveryStore, principal: OperatorActor): Promise<DemoGeographySummary> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('Demo geography cannot run in production mode');
  return store.db.source.transaction(async (manager) => {
    const target = await rows(manager, z.object({
      name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432),
    }), 'SELECT current_database() AS name, inet_server_port() AS port');
    if (target.length !== 1) throw new Error('Expected one isolated local database');
    await manager.query('SELECT pg_advisory_xact_lock(7041001)');
    const candidates = await rows(manager, z.object({ id: z.string().uuid(), sourceId: z.number().int(), version: z.number().int(), data: DeliverySchema }),
      `SELECT id, source_id AS "sourceId", version, data FROM delivery
       WHERE source_instance=$1 AND source_id BETWEEN 1 AND 20 ORDER BY source_id FOR UPDATE`, [importedDemoSourceInstance]);
    const summary: DemoGeographySummary = { updated: [], skipped: [] };
    for (const { id, sourceId, version, data: delivery } of candidates) {
      if (delivery.id !== id || delivery.version !== version) throw new Error('Delivery identity or version mismatch; demo geography was not applied');
      const base = { id, pickingName: delivery.source.pickingName };
      const fixture = matchDemoAddress(sourceId, delivery);
      if ('reason' in fixture) {
        summary.skipped.push({ ...base, reason: fixture.reason });
        continue;
      }
      if (delivery.addressGeography !== undefined) {
        summary.skipped.push({ ...base, reason: 'existing_geography' });
        continue;
      }
      const postalCode = postalCodesByCustomer.get(fixture.customerId);
      if (postalCode === undefined) throw new Error('Verified demo customer has no postal-code fixture');
      const geography = AddressGeographySchema.parse({
        addressKey: destinationAddressKey(delivery.source.customer), sourceCustomerId: fixture.customerId,
        province: delivery.source.customer.city === 'Catania' ? 'CT' : 'ME', postalCode, source: 'synthetic_fixture',
      });
      await manager.query(`UPDATE delivery SET version=version+1,
        data=jsonb_set(jsonb_set(data,'{addressGeography}',$2::jsonb),'{version}',to_jsonb(version+1)) WHERE id=$1`,
      [id, JSON.stringify(geography)]);
      await store.audit(manager, principal, auditAction, {
        synthetic: true, addressKey: geography.addressKey, sourceCustomerId: fixture.customerId,
        province: geography.province, postalCode, version: version + 1,
      }, id);
      summary.updated.push({ ...base, geography });
    }
    return summary;
  });
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply' || process.env['NODE_ENV'] === 'production') {
    throw new Error('Use demo-geography.ts --apply only on the local synthetic stand');
  }
  const app = await createApp(true);
  let request: { headers: { cookie: string } } | undefined;
  try {
    await app.init();
    const raw: unknown = JSON.parse(await readFile('.local/demo-accounts.json', 'utf8'));
    const identity = app.get(Identity);
    const login = await identity.login(AccountsSchema.parse(raw).operator);
    request = { headers: { cookie: `backoffice_session=${login.token}` } };
    const principal = await identity.authenticate(request);
    console.log(JSON.stringify(await seedDemoGeography(app.get(DeliveryStore), principal), null, 2));
  } finally {
    try {
      if (request) await app.get(Identity).logout(request);
    } finally {
      await app.close();
    }
  }
}

if (require.main === module) void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Demo geography population failed');
  process.exitCode = 1;
});
