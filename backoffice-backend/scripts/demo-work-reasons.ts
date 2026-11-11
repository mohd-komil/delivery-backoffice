import { readFile } from 'node:fs/promises';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { createDelivery, DeliverySchema, IdSchema, type Delivery, type SourceItem } from '../src/domain/model';
import { PublicDemoAddressesSchema } from './demo-public-addresses';

export const workReasonsDemoSource = 'work_reasons_demo';
export const workReasonsDemoId = 'a5d69c9e-38ed-4d2e-a411-755b50aa1001';
const sourceId = 930001;

function chair(sourceLineId: number, saleOrderId: number): SourceItem {
  return {
    sourceLineId, saleOrderId, productId: 9301, name: 'DEMO Oak chair (WR-CHAIR)', quantity: 2, uom: 'unit',
    description: 'Synthetic matching chairs from two separate sales orders. Report each order line independently.',
    configuration: 'Natural oak / beige seat', ambient: 'Dining room',
    notes: 'Demo instruction: verify the sales order and line before unloading. Protect the floor and check all four legs.',
    photoUrl: null,
  };
}

/** Initial source data only: no appointments, assignments, execution facts or evidence. */
export function workReasonsDemoFixture(addressCatalog: unknown): Delivery {
  const address = PublicDemoAddressesSchema.parse(addressCatalog).find((candidate) => candidate.customerId === 3);
  if (!address) throw new Error('The reviewed public address reference for the work-reasons demo is missing');
  const customer = {
    id: 9301, name: 'DEMO Elena Marino', address: address.street, city: address.city, country: 'IT',
    phones: ['+39 000 000 9301'], email: 'elena.marino@example.test', contact: 'Fictional demonstration customer',
  };
  const delivery = createDelivery({
    pickingId: 93001, pickingName: 'DEMO/REASONS/0001',
    saleOrderId: 9301, saleOrderName: 'DEMO/WR/SO/9301',
    salesOrders: [{ id: 9301, name: 'DEMO/WR/SO/9301' }, { id: 9302, name: 'DEMO/WR/SO/9302' }],
    sourceState: 'assigned', salesTeam: 'DEMO incomplete work reporting', customer,
    items: [chair(930011, 9301), chair(930021, 9302)], serviceType: null, estimatedMinutes: 100,
    notes: `Synthetic work-reasons demonstration; not imported from Odoo. Fictional customer at the public reference ${address.venue}. Building coordinates, not a verified unloading entrance.`,
  }, workReasonsDemoId);
  return DeliverySchema.parse({
    ...delivery,
    servicePlan: { defaultService: 'delivery_installation', overrides: [] },
    routePoint: address.point,
    addressGeography: {
      addressKey: destinationAddressKey(customer), sourceCustomerId: customer.id,
      province: address.province, postalCode: address.postalCode, source: 'synthetic_fixture',
    },
  });
}

/** Repeatable insertion never overwrites a demo that somebody has already planned or worked on. */
export async function seedWorkReasonsDemo(database: DataSource, addressCatalog: unknown, testDatabase: boolean): Promise<number> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('The work-reasons fixture is restricted to the local teaching stand');
  const delivery = workReasonsDemoFixture(addressCatalog);
  return database.transaction(async (manager) => {
    const target = await rows(manager, z.object({
      name: z.literal(testDatabase ? 'delivery_backoffice_test' : 'delivery_backoffice'), port: z.literal(55432),
    }), 'SELECT current_database() AS name, inet_server_port() AS port');
    if (target.length !== 1) throw new Error('Expected the named isolated local database');
    const inserted = await rows(manager, z.object({ id: IdSchema }), `
      INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (source_instance,source_id) DO NOTHING RETURNING id`,
    [delivery.id, workReasonsDemoSource, sourceId, delivery.version, JSON.stringify(delivery)]);
    if (inserted.length === 1) return 1;
    const [existing] = await rows(manager, z.object({ id: IdSchema }),
      'SELECT id FROM delivery WHERE source_instance=$1 AND source_id=$2', [workReasonsDemoSource, sourceId]);
    if (existing?.id !== delivery.id) throw new Error('Work-reasons demo fixture identity conflict; nothing was changed');
    return 0;
  });
}

async function main(): Promise<void> {
  const argument = process.argv[2];
  if (process.argv.length !== 3 || (argument !== '--apply' && argument !== '--test')) {
    throw new Error('Use --apply for the isolated local demo stand, or --test for the isolated test database');
  }
  const catalog: unknown = JSON.parse(await readFile('local/public-demo-addresses.json', 'utf8'));
  const database = makeDataSource(argument === '--test');
  await database.initialize();
  try {
    const inserted = await seedWorkReasonsDemo(database, catalog, argument === '--test');
    console.log(`Work-reasons demo ready. Inserted ${inserted} of 1 new delivery; existing state was preserved.`);
    console.log(`DEMO/REASONS/0001 | ${workReasonsDemoId} | orders 9301 / 9302, lines 930011 / 930021, same SKU WR-CHAIR`);
  } finally {
    await database.destroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    // Connection errors can expose secrets; use a stable safe message.
    console.error(error instanceof z.ZodError
      ? 'Work-reasons demo reference or isolated database validation failed'
      : 'Work-reasons demo preparation failed; verify the local stand and use --apply or --test');
    process.exitCode = 1;
  });
}
