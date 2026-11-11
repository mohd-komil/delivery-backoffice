import { readFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { rows, type Executor } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { AddressGeographySchema } from '../src/domain/delivery-geography';
import { DeliverySchema, GeoPointSchema, type OperatorActor } from '../src/domain/model';
import { Identity } from '../src/identity/identity';
import { Importer } from '../src/integration/importer';
import { DeliveryStore } from '../src/operations/store';
import { importedDemoSourceInstance } from './demo-fixtures';

const EvidenceUrlSchema = z.string().url().max(2000).refine((value) => new URL(value).protocol === 'https:', 'Use an HTTPS reference');
export const PublicDemoAddressesSchema = z.array(z.object({
  customerId: z.number().int().min(1).max(11), venue: z.string().trim().min(1).max(200),
  street: z.string().trim().min(1).max(300).refine((value) => !value.startsWith('Via Dimostrativa'), 'Use the documented public address'),
  city: z.enum(['Catania', 'Messina']), province: z.enum(['CT', 'ME']), postalCode: z.string().regex(/^\d{5}$/),
  point: GeoPointSchema, addressSource: EvidenceUrlSchema, coordinateSource: EvidenceUrlSchema,
  checkedAt: z.literal('2026-11-09'), accuracy: z.literal('building_reference'),
}).strict()).length(11).superRefine((fixtures, context) => {
  if (new Set(fixtures.map((fixture) => fixture.customerId)).size !== 11) {
    context.addIssue({ code: 'custom', message: 'Provide one public-address fixture for each customer 1 through 11' });
  }
  for (const fixture of fixtures) {
    const messina = fixture.customerId % 2 === 0;
    if (fixture.city !== (messina ? 'Messina' : 'Catania') || fixture.province !== (messina ? 'ME' : 'CT')) {
      context.addIssue({ code: 'custom', message: 'Preserve the original demo customer city and its province' });
    }
  }
});
type PublicDemoAddress = z.infer<typeof PublicDemoAddressesSchema>[number];
const AccountsSchema = z.object({ operator: z.object({ email: z.string().email(), password: z.string().min(1).max(256) }) });

function refuseProduction(): void {
  if (process.env['NODE_ENV'] === 'production') throw new Error('Public demo addresses cannot run in production mode');
}

async function assertApplicationTarget(executor: Executor): Promise<void> {
  const target = await rows(executor, z.object({
    name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432),
  }), 'SELECT current_database() AS name, inet_server_port() AS port');
  if (target.length !== 1) throw new Error('Expected one isolated local application database');
}

async function assertSourceTarget(source: DataSource, executor: Executor): Promise<void> {
  const expected = new URL(config().ODOO_DATABASE_URL);
  if (source.options.type !== 'postgres') throw new Error('Use the isolated PostgreSQL teaching source');
  const url = new URL(z.string().parse(source.options.url));
  if (url.protocol !== 'postgresql:' || url.hostname !== expected.hostname || url.port !== '55432'
    || url.pathname !== '/odoo_mock' || url.username !== 'odoo_seed' || url.hash !== ''
    || [...url.searchParams.keys()].some((key) => key !== 'options') || url.searchParams.getAll('options').length > 1) {
    throw new Error('Use only the local odoo_mock fixture-owner connection');
  }
  const target = await rows(executor, z.object({
    name: z.literal('odoo_mock'), port: z.literal(55432), owner: z.literal('odoo_seed'),
    schema: z.string().regex(/^(public|public_addresses_source_[0-9a-f]{32})$/),
    relationSchema: z.string(),
  }), `SELECT current_database() AS name, inet_server_port() AS port, current_user AS owner,
    current_schema() AS schema, n.nspname AS "relationSchema"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass('res_partner')`);
  if (target.length !== 1 || target[0]?.schema !== target[0]?.relationSchema) {
    throw new Error('Source fixture table must belong to the verified local schema');
  }
}

export type PublicDemoSourceSummary = {
  updated: { customerId: number; previousStreet: string; street: string }[];
  skipped: { customerId: number; reason: 'fixture_changed' | 'already_target' | 'missing' }[];
};

/** Fixture maintenance only: the application's Odoo adapter and its credentials remain read-only. */
export async function updatePublicDemoSource(source: DataSource, input: unknown): Promise<PublicDemoSourceSummary> {
  refuseProduction();
  const fixtures = PublicDemoAddressesSchema.parse(input);
  return source.transaction(async (manager) => {
    await assertSourceTarget(source, manager);
    const partners = await rows(manager, z.object({
      id: z.number().int(), name: z.string(), street: z.string().nullable(), city: z.string().nullable(), country: z.string().nullable(),
    }), 'SELECT id,name,street,city,country_code AS country FROM res_partner WHERE id BETWEEN 1 AND 11 ORDER BY id FOR UPDATE');
    const summary: PublicDemoSourceSummary = { updated: [], skipped: [] };
    for (const fixture of fixtures) {
      const partner = partners.find((candidate) => candidate.id === fixture.customerId);
      if (!partner) { summary.skipped.push({ customerId: fixture.customerId, reason: 'missing' }); continue; }
      const originalStreet = `Via Dimostrativa ${fixture.customerId}`;
      if (partner.name !== `DEMO Customer ${String(fixture.customerId).padStart(2, '0')}`
        || partner.city !== fixture.city || partner.country !== 'IT'
        || (partner.street !== originalStreet && partner.street !== fixture.street)) {
        summary.skipped.push({ customerId: fixture.customerId, reason: 'fixture_changed' });
        continue;
      }
      if (partner.street === fixture.street) {
        summary.skipped.push({ customerId: fixture.customerId, reason: 'already_target' });
        continue;
      }
      const updated = await rows(manager, z.object({ id: z.number().int() }),
        'WITH updated AS (UPDATE res_partner SET street=$2 WHERE id=$1 AND street=$3 RETURNING id) SELECT id FROM updated',
        [fixture.customerId, fixture.street, originalStreet]);
      if (updated.length !== 1) throw new Error('The locked source fixture changed unexpectedly');
      summary.updated.push({ customerId: fixture.customerId, previousStreet: originalStreet, street: fixture.street });
    }
    return summary;
  });
}

export type PublicDemoDestinationsSummary = {
  updated: { id: string; pickingName: string; customerId: number; pointAdded: boolean; geographyAdded: boolean }[];
  skipped: { id: string; pickingName: string; reason: 'fixture_changed' | 'incomplete_address' | 'source_review' | 'existing_metadata' }[];
};

/** Seed only missing address-bound references; a building reference never confirms a delivery entrance. */
export async function seedPublicDemoDestinations(store: DeliveryStore, principal: OperatorActor, input: unknown): Promise<PublicDemoDestinationsSummary> {
  refuseProduction();
  const fixtures = new Map(PublicDemoAddressesSchema.parse(input).map((fixture) => [fixture.customerId, fixture]));
  return store.db.source.transaction(async (manager) => {
    await assertApplicationTarget(manager);
    await manager.query('SELECT pg_advisory_xact_lock(7041001)');
    const candidates = await rows(manager, z.object({ id: z.string().uuid(), sourceId: z.number().int(), version: z.number().int(), data: DeliverySchema }),
      `SELECT id,source_id AS "sourceId",version,data FROM delivery
       WHERE source_instance=$1 AND source_id BETWEEN 1 AND 20 ORDER BY source_id FOR UPDATE`, [importedDemoSourceInstance]);
    const summary: PublicDemoDestinationsSummary = { updated: [], skipped: [] };
    for (const { id, sourceId, version, data: delivery } of candidates) {
      if (delivery.id !== id || delivery.version !== version) throw new Error('Delivery identity or version mismatch; public references were not applied');
      const base = { id, pickingName: delivery.source.pickingName };
      const expectedCustomerId = sourceId === 2 ? 1 : ((sourceId - 1) % 12) + 1;
      const fixture = fixtures.get(expectedCustomerId);
      if (expectedCustomerId === 12 && delivery.source.customer.address === null) {
        summary.skipped.push({ ...base, reason: 'incomplete_address' }); continue;
      }
      if (!fixture || delivery.source.pickingId !== sourceId || delivery.source.pickingName !== `DEMO/OUT/${String(sourceId).padStart(4, '0')}`
        || !matchesDestination(delivery.source.customer, fixture)) {
        summary.skipped.push({ ...base, reason: 'fixture_changed' }); continue;
      }
      if (delivery.sourceReview) { summary.skipped.push({ ...base, reason: 'source_review' }); continue; }
      const addressKey = destinationAddressKey(delivery.source.customer);
      const entrance = await rows(manager, z.object({ exists: z.boolean() }),
        `SELECT EXISTS (SELECT 1 FROM destination_entrance WHERE source_instance=$1 AND source_customer_id=$2 AND address_key=$3) AS exists`,
        [importedDemoSourceInstance, fixture.customerId, addressKey]);
      const pointAdded = delivery.routePoint === undefined && entrance[0]?.exists === false;
      const geographyAdded = delivery.addressGeography === undefined;
      if (!pointAdded && !geographyAdded) { summary.skipped.push({ ...base, reason: 'existing_metadata' }); continue; }
      const geography = AddressGeographySchema.parse({ addressKey, sourceCustomerId: fixture.customerId,
        province: fixture.province, postalCode: fixture.postalCode, source: 'synthetic_fixture' });
      // Patch only the new reference fields and version, retaining all operational data.
      await manager.query(`UPDATE delivery SET version=version+1,data=jsonb_set(
        CASE WHEN $4 THEN jsonb_set(CASE WHEN $2 THEN jsonb_set(data,'{routePoint}',$3::jsonb) ELSE data END,'{addressGeography}',$5::jsonb)
          ELSE CASE WHEN $2 THEN jsonb_set(data,'{routePoint}',$3::jsonb) ELSE data END END,'{version}',to_jsonb(version+1)) WHERE id=$1`,
      [id, pointAdded, JSON.stringify(fixture.point), geographyAdded, JSON.stringify(geography)]);
      await store.audit(manager, principal, 'demo.public_address_reference_added', {
        synthetic: true, pointSource: 'synthetic_fixture', sourceCustomerId: fixture.customerId, addressKey,
        venue: fixture.venue, street: fixture.street, point: fixture.point, province: fixture.province, postalCode: fixture.postalCode,
        addressSource: fixture.addressSource, coordinateSource: fixture.coordinateSource, checkedAt: fixture.checkedAt,
        accuracy: fixture.accuracy, entranceConfirmed: false, pointAdded, geographyAdded, version: version + 1,
      }, id);
      summary.updated.push({ ...base, customerId: fixture.customerId, pointAdded, geographyAdded });
    }
    return summary;
  });
}

function matchesDestination(customer: { id: number; name: string; address: string | null; city: string | null; country: string | null }, fixture: PublicDemoAddress): boolean {
  return customer.id === fixture.customerId && customer.name === `DEMO Customer ${String(fixture.customerId).padStart(2, '0')}`
    && customer.address === fixture.street && customer.city === fixture.city && customer.country === 'IT';
}

async function main(): Promise<void> {
  refuseProduction();
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') throw new Error('Use demo-public-addresses.ts --apply only on the local synthetic stand');
  const environment = config();
  const readerUrl = new URL(environment.ODOO_DATABASE_URL);
  if (readerUrl.username !== 'odoo_reader' || readerUrl.search !== '') throw new Error('CLI requires the normal local read-only source connection without schema overrides');
  const raw: unknown = JSON.parse(await readFile('local/public-demo-addresses.json', 'utf8'));
  const fixtures = PublicDemoAddressesSchema.parse(raw);
  const PasswordSchema = z.string().length(48).regex(/^[0-9a-f]{48}$/);
  if (environment.BACKOFFICE_RUNTIME === 'docker') {
    readerUrl.password = PasswordSchema.parse(await readFile('/run/secrets/source_owner_password', 'utf8'));
  } else {
    const credentials: unknown = JSON.parse(await readFile('.local/postgres-credentials.json', 'utf8'));
    readerUrl.password = z.object({ sourceOwner: PasswordSchema }).parse(credentials).sourceOwner;
  }
  readerUrl.username = 'odoo_seed';
  const source = new DataSource({ type: 'postgres', url: readerUrl.toString(), entities: [], synchronize: false, logging: false });
  const app = await createApp(true);
  let request: { headers: { cookie: string } } | undefined;
  try {
    await app.init();
    const rawAccounts: unknown = JSON.parse(await readFile('.local/demo-accounts.json', 'utf8'));
    const identity = app.get(Identity);
    const login = await identity.login(AccountsSchema.parse(rawAccounts).operator);
    request = { headers: { cookie: `backoffice_session=${login.token}` } };
    const principal = await identity.authenticate(request);
    const store = app.get(DeliveryStore);
    await assertApplicationTarget(store.db.source.manager);
    await source.initialize();
    const sourceSummary = await updatePublicDemoSource(source, fixtures);
    const importRun = await app.get(Importer).run(principal);
    if (importRun.status !== 'succeeded') throw new Error('Fixture maintenance completed but the normal import did not succeed; inspect Import history and rerun safely');
    const destinations = await seedPublicDemoDestinations(store, principal, fixtures);
    console.log(JSON.stringify({ source: sourceSummary, import: { id: importRun.id, status: importRun.status, processed: importRun.processed }, destinations }, null, 2));
  } finally {
    try {
      if (request) await app.get(Identity).logout(request);
    } finally {
      try { if (source.isInitialized) await source.destroy(); }
      finally { await app.close(); }
    }
  }
}

if (require.main === module) void main().catch((error: unknown) => {
  // Dependency errors may contain credentials, even when they are plain Error instances.
  console.error(error instanceof z.ZodError ? 'Public demo fixture or local database validation failed' :
    'Public demo address update failed; inspect the local stand and Import history before a safe rerun');
  process.exitCode = 1;
});
