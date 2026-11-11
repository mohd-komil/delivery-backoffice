import { readFile } from 'node:fs/promises';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { createDelivery, DeliverySchema, IdSchema, type Delivery } from '../src/domain/model';
import { workReasonsDemoFixture } from './demo-work-reasons';

export const operationsFollowupDemoId = 'a5d69c9e-38ed-4d2e-a411-755b50aa2001';
export const operationsFollowupDemoSource = 'operations_followup_demo';

/** Reuse the reviewed public address and source-line teaching format, with separate demo identities. */
export function operationsFollowupDemoFixture(addressCatalog: unknown): Delivery {
  const reference = workReasonsDemoFixture(addressCatalog);
  const customer = { ...reference.source.customer, id: 9401, name: 'DEMO Giulia Moretti', email: 'giulia.moretti@example.test', phones: ['+39 000 000 9401'] };
  const source = { ...reference.source, pickingId: 94001, pickingName: 'DEMO/FOLLOWUP/0001', saleOrderId: 9401, saleOrderName: 'DEMO/FOLLOWUP/SO/9401',
    salesOrders: [{ id: 9401, name: 'DEMO/FOLLOWUP/SO/9401' }, { id: 9402, name: 'DEMO/FOLLOWUP/SO/9402' }], customer,
    salesTeam: 'DEMO product issues and readiness', serviceType: 'delivery_installation',
    items: reference.source.items.map((item, index) => ({ ...item, sourceLineId: index === 0 ? 940011 : 940021,
      saleOrderId: index === 0 ? 9401 : 9402, productId: 9401, name: 'DEMO Oak chair (FOLLOWUP-CHAIR)',
      notes: 'Synthetic demonstration: verify the sales order, inspect the chair and use the instruction attached to this exact line.' })),
    notes: 'Synthetic Problem → Issues and damaged-work readiness demonstration. Not an Odoo import or real customer visit. Public building reference, not a confirmed unloading entrance.',
  };
  return DeliverySchema.parse({ ...createDelivery(source, operationsFollowupDemoId), routePoint: reference.routePoint,
    addressGeography: reference.addressGeography ? { ...reference.addressGeography, sourceCustomerId: customer.id, addressKey: destinationAddressKey(customer) } : undefined });
}

/** Insert source data only. A repeated command never replaces anybody's planned or reported work. */
export async function seedOperationsFollowupDemo(database: DataSource, addressCatalog: unknown, testDatabase: boolean) {
  if (process.env['NODE_ENV'] === 'production') throw new Error('This fixture is restricted to the local teaching stand');
  const delivery = operationsFollowupDemoFixture(addressCatalog);
  return database.transaction(async (manager) => {
    const target = await rows(manager, z.object({ name: z.literal(testDatabase ? 'delivery_backoffice_test' : 'delivery_backoffice'), port: z.literal(55432) }),
      'SELECT current_database() AS name, inet_server_port() AS port');
    if (target.length !== 1) throw new Error('Expected the isolated local database');
    const inserted = await rows(manager, z.object({ id: IdSchema }), `INSERT INTO delivery(id,source_instance,source_id,version,data)
      VALUES($1,$2,940001,$3,$4::jsonb) ON CONFLICT (source_instance,source_id) DO NOTHING RETURNING id`,
    [delivery.id, operationsFollowupDemoSource, delivery.version, JSON.stringify(delivery)]);
    if (inserted.length === 1) return 1;
    const existing = await rows(manager, z.object({ id: IdSchema }), 'SELECT id FROM delivery WHERE source_instance=$1 AND source_id=940001', [operationsFollowupDemoSource]);
    if (existing[0]?.id !== delivery.id) throw new Error('Demo identity conflict; nothing was changed');
    return 0;
  });
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== '--apply' && mode !== '--test')) throw new Error('Use --apply or --test');
  const catalog: unknown = JSON.parse(await readFile('local/public-demo-addresses.json', 'utf8'));
  const database = makeDataSource(mode === '--test');
  await database.initialize();
  try {
    const count = await seedOperationsFollowupDemo(database, catalog, mode === '--test');
    console.log(`DEMO/FOLLOWUP/0001: inserted ${count} source-only delivery. Existing work preserved. Delivery ID ${operationsFollowupDemoId}.`);
  } finally { await database.destroy(); }
}

if (require.main === module) void main().catch(() => {
  console.error('Follow-up demo preparation failed. Verify the local isolated stand and --apply/--test argument.'); process.exitCode = 1;
});
