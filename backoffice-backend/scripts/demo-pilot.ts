import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { makeDataSource, rows } from '../src/database/database';
import { createDelivery, DeliverySchema, IdSchema, type Delivery, type SourceItem, type SourceSnapshot } from '../src/domain/model';
import { demoRouteAddressIds } from '../src/routing/demo-estimates';

const sourceInstance = 'mvp_demo';
const chairProductId = 9101;
const pickingOne = { pickingId: 91001, pickingName: 'DEMO/MVP/0001' };
const pickingTwo = { pickingId: 91002, pickingName: 'DEMO/MVP/0002' };
type ServicePlan = NonNullable<Delivery['servicePlan']>;

function order(id: number) {
  return { id, name: `DEMO/MVP/SO/${id}` };
}

function customer(id: number, label: string, address: string, city: string): SourceSnapshot['customer'] {
  return { id, name: `DEMO ${label}`, address, city, country: 'IT', phones: ['+39 000 000 0000'], email: null, contact: null };
}

function item(sourceLineId: number, saleOrderId: number, productId: number, name: string, quantity: number): SourceItem {
  return { sourceLineId, saleOrderId, productId, name, quantity, uom: 'unit', description: null,
    configuration: null, ambient: null, notes: null, photoUrl: null };
}

function chair(sourceLineId: number, saleOrderId: number, quantity: number): SourceItem {
  return item(sourceLineId, saleOrderId, chairProductId, 'DEMO Chair (MVP-CHAIR)', quantity);
}

function pilotDelivery(fixture: {
  id: string;
  picking: Pick<SourceSnapshot, 'pickingId' | 'pickingName'>;
  primaryOrder: ReturnType<typeof order>;
  additionalOrders?: ReturnType<typeof order>[];
  customer: SourceSnapshot['customer'];
  items: SourceItem[];
  servicePlan: ServicePlan;
  estimatedMinutes: number;
  routePoint: NonNullable<Delivery['routePoint']>;
}): Delivery {
  const delivery = createDelivery({
    ...fixture.picking,
    saleOrderId: fixture.primaryOrder.id,
    saleOrderName: fixture.primaryOrder.name,
    salesOrders: [fixture.primaryOrder, ...(fixture.additionalOrders ?? [])],
    sourceState: 'assigned',
    salesTeam: 'DEMO MVP',
    customer: fixture.customer,
    items: fixture.items,
    serviceType: null,
    estimatedMinutes: fixture.estimatedMinutes,
    notes: 'Synthetic address-level delivery for the MVP pilot.',
  }, fixture.id);
  return DeliverySchema.parse({ ...delivery, servicePlan: fixture.servicePlan, routePoint: fixture.routePoint });
}

const firstOrder = order(9101);
const secondOrder = order(9102);
const collectionOrder = order(9103);
const nextPickingOrder = order(9104);

const fixtures = [
  {
    sourceId: 910001,
    delivery: pilotDelivery({
      id: demoRouteAddressIds.milano,
      picking: pickingOne,
      primaryOrder: firstOrder,
      additionalOrders: [secondOrder],
      customer: customer(9101, 'Pilot A', 'Via DEMO Alfa 1', 'Milano'),
      items: [chair(910011, firstOrder.id, 2), chair(910021, secondOrder.id, 1),
        item(910022, secondOrder.id, 9102, 'DEMO Bookcase (MVP-BOOKCASE)', 1)],
      servicePlan: { defaultService: 'delivery_installation', overrides: [
        { sourceLineId: 910021, service: 'delivery_only' },
        { sourceLineId: 910022, service: 'installation_only' },
      ] },
      estimatedMinutes: 45,
      routePoint: { latitude: 45.4642, longitude: 9.1900 },
    }),
  },
  {
    sourceId: 910002,
    delivery: pilotDelivery({
      id: demoRouteAddressIds.sesto,
      picking: pickingOne,
      primaryOrder: collectionOrder,
      customer: customer(9102, 'Pilot B', 'Via DEMO Beta 2', 'Sesto San Giovanni'),
      items: [chair(910031, collectionOrder.id, 1)],
      servicePlan: { defaultService: 'collection_only', overrides: [] },
      estimatedMinutes: 25,
      routePoint: { latitude: 45.5346, longitude: 9.2343 },
    }),
  },
  {
    sourceId: 910003,
    delivery: pilotDelivery({
      id: demoRouteAddressIds.monza,
      picking: pickingTwo,
      primaryOrder: nextPickingOrder,
      customer: customer(9103, 'Pilot C', 'Via DEMO Gamma 3', 'Monza'),
      items: [chair(910041, nextPickingOrder.id, 1)],
      servicePlan: { defaultService: 'delivery_only', overrides: [] },
      estimatedMinutes: 30,
      routePoint: { latitude: 45.5845, longitude: 9.2744 },
    }),
  },
];

export async function seedMvpPilot(database: DataSource): Promise<number> {
  return database.transaction(async (manager) => {
    await rows(manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name');
    let inserted = 0;
    for (const { sourceId, delivery } of fixtures) {
      const result = await rows(manager, z.object({ id: IdSchema }), `
        INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (source_instance,source_id) DO NOTHING RETURNING id`,
      [delivery.id, sourceInstance, sourceId, delivery.version, JSON.stringify(delivery)]);
      if (result.length === 1) {
        inserted += 1;
        continue;
      }
      const [existing] = await rows(manager, z.object({ id: IdSchema }),
        'SELECT id FROM delivery WHERE source_instance=$1 AND source_id=$2', [sourceInstance, sourceId]);
      if (existing?.id !== delivery.id) throw new Error('MVP demo fixture identity conflict');
    }
    return inserted;
  });
}

async function main(): Promise<void> {
  if (!process.argv.includes('--test') || process.env['NODE_ENV'] === 'production') {
    throw new Error('The MVP pilot requires --test and the isolated delivery_backoffice_test database');
  }
  const database = makeDataSource(true);
  await database.initialize();
  try {
    const inserted = await seedMvpPilot(database);
    console.log(`MVP pilot ready in delivery_backoffice_test. Inserted ${inserted} of ${fixtures.length} address deliveries.`);
    for (const { delivery } of fixtures) console.log(`${delivery.source.pickingName} | ${delivery.source.customer.address} | ${delivery.id}`);
  } finally {
    await database.destroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'MVP pilot seed failed');
    process.exitCode = 1;
  });
}
