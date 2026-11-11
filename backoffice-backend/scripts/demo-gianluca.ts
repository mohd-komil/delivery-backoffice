import { readFile } from 'node:fs/promises';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { createDelivery, DeliverySchema, IdSchema, type Delivery, type SourceItem } from '../src/domain/model';
import { PublicDemoAddressesSchema } from './demo-public-addresses';

export const gianlucaDemoSource = 'gianluca_demo';
export const gianlucaDemoIds = {
  primary: 'e2da8ac2-102d-4a74-a942-1706085fa401',
  secondary: 'e2da8ac2-102d-4a74-a942-1706085fa402',
} as const;

function chair(sourceLineId: number, saleOrderId: number, quantity: number): SourceItem {
  return {
    sourceLineId, saleOrderId, productId: 9201, name: 'DEMO Oak chair (GI-CHAIR)', quantity, uom: 'unit',
    description: 'Synthetic oak chair. The identical SKU belongs to separate sales-order lines.',
    configuration: 'Natural oak / beige seat', ambient: 'Dining room',
    notes: 'Demo instruction: verify the order and line before reporting quantities. Protect the floor and check all four legs.',
    photoUrl: null,
  };
}

/** Reuse the verified local public-address catalog; these are not confirmed unloading entrances. */
export function gianlucaDemoFixtures(addressCatalog: unknown): { sourceId: number; delivery: Delivery }[] {
  const addresses = PublicDemoAddressesSchema.parse(addressCatalog);
  return [
    {
      id: gianlucaDemoIds.primary, sourceId: 920001, pickingId: 92001, pickingName: 'DEMO/GIANLUCA/0001',
      customerId: 9201, customerName: 'DEMO Sofia Romano', email: 'sofia.romano@example.test',
      addressReferenceId: 3, orderIds: [9201, 9202], items: [chair(920011, 9201, 2), chair(920021, 9202, 1)],
      servicePlan: { defaultService: 'delivery_installation', overrides: [{ sourceLineId: 920021, service: 'delivery_only' }] },
      estimatedMinutes: 90,
    },
    {
      id: gianlucaDemoIds.secondary, sourceId: 920002, pickingId: 92002, pickingName: 'DEMO/GIANLUCA/0002',
      customerId: 9202, customerName: 'DEMO Luca Conti', email: 'luca.conti@example.test',
      addressReferenceId: 9, orderIds: [9203], items: [chair(920031, 9203, 1)],
      servicePlan: { defaultService: 'delivery_only', overrides: [] }, estimatedMinutes: 30,
    },
  ].map((fixture) => {
    const address = addresses.find((candidate) => candidate.customerId === fixture.addressReferenceId);
    const primaryOrderId = fixture.orderIds[0];
    if (!address || primaryOrderId === undefined) throw new Error('The reviewed Gianluca demo reference is missing');
    const customer = {
      id: fixture.customerId, name: fixture.customerName, address: address.street,
      city: address.city, country: 'IT', phones: [`+39 000 000 ${fixture.customerId}`],
      email: fixture.email, contact: 'Fictional demonstration customer',
    };
    const delivery = createDelivery({
      pickingId: fixture.pickingId, pickingName: fixture.pickingName,
      saleOrderId: primaryOrderId, saleOrderName: `DEMO/GI/SO/${primaryOrderId}`,
      salesOrders: fixture.orderIds.map((id) => ({ id, name: `DEMO/GI/SO/${id}` })),
      sourceState: 'assigned', salesTeam: 'DEMO Gianluca presentation', customer, items: fixture.items,
      serviceType: null, estimatedMinutes: fixture.estimatedMinutes,
      notes: `Synthetic presentation data; not imported from Odoo. Fictional customer at the public reference ${address.venue}. Building coordinates, not a verified unloading entrance.`,
    }, fixture.id);
    return { sourceId: fixture.sourceId, delivery: DeliverySchema.parse({
      ...delivery, servicePlan: fixture.servicePlan, routePoint: address.point,
      addressGeography: { addressKey: destinationAddressKey(customer), sourceCustomerId: customer.id,
        province: address.province, postalCode: address.postalCode, source: 'synthetic_fixture' },
    }) };
  });
}

/** Add only missing initial deliveries; never reset a presentation already worked on. */
export async function seedGianlucaDemo(database: DataSource, addressCatalog: unknown, testDatabase: boolean): Promise<number> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('The Gianluca fixture is restricted to the local teaching stand');
  const fixtures = gianlucaDemoFixtures(addressCatalog);
  return database.transaction(async (manager) => {
    const target = await rows(manager, z.object({
      name: z.literal(testDatabase ? 'delivery_backoffice_test' : 'delivery_backoffice'), port: z.literal(55432),
    }), 'SELECT current_database() AS name, inet_server_port() AS port');
    if (target.length !== 1) throw new Error('Expected the named isolated local database');
    let inserted = 0;
    for (const { sourceId, delivery } of fixtures) {
      const result = await rows(manager, z.object({ id: IdSchema }), `
        INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (source_instance,source_id) DO NOTHING RETURNING id`,
      [delivery.id, gianlucaDemoSource, sourceId, delivery.version, JSON.stringify(delivery)]);
      if (result.length === 1) { inserted += 1; continue; }
      const [existing] = await rows(manager, z.object({ id: IdSchema }),
        'SELECT id FROM delivery WHERE source_instance=$1 AND source_id=$2', [gianlucaDemoSource, sourceId]);
      if (existing?.id !== delivery.id) throw new Error('Gianluca demo fixture identity conflict; nothing was changed');
    }
    return inserted;
  });
}

async function main(): Promise<void> {
  const argument = process.argv[2];
  if (process.argv.length !== 3 || (argument !== '--apply' && argument !== '--test')) {
    throw new Error('Use --apply for the isolated local presentation stand, or --test for the isolated test database');
  }
  const catalog: unknown = JSON.parse(await readFile('local/public-demo-addresses.json', 'utf8'));
  const database = makeDataSource(argument === '--test');
  await database.initialize();
  try {
    const inserted = await seedGianlucaDemo(database, catalog, argument === '--test');
    console.log(`Gianluca demo ready. Inserted ${inserted} of 2 new deliveries; existing state was preserved.`);
    for (const { delivery } of gianlucaDemoFixtures(catalog)) {
      console.log(`${delivery.source.pickingName} | ${delivery.source.customer.address} | ${delivery.id}`);
    }
  } finally {
    await database.destroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    // Connection errors may contain secrets; do not print dependency error messages.
    console.error(error instanceof z.ZodError
      ? 'Gianluca demo reference or isolated database validation failed'
      : 'Gianluca demo preparation failed; verify the local stand and use --apply or --test');
    process.exitCode = 1;
  });
}
