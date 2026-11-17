import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { deliveryListSchema, deliveryPlanningSchema, type DeliveryList } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, listFixture } from './refresh-fixtures';

const firstVisitId = '60000000-0000-4000-8000-000000000001';
const secondVisitId = '60000000-0000-4000-8000-000000000002';
const crewId = '60000000-0000-4000-8000-000000000003';
const otherCrewId = '60000000-0000-4000-8000-000000000004';

function planning(input: Partial<ReturnType<typeof deliveryPlanningSchema.parse>> = {}) {
  return deliveryPlanningSchema.parse({
    status: 'inbox', activeVisits: [],
    remainingWorkEstimate: { minutes: 30, basis: 'proportional_remaining_operations', sourceMinutes: 120 },
    ...input,
  });
}

function rowFixture(summary: ReturnType<typeof planning> | undefined = planning()): DeliveryList['items'][number] {
  const base = listFixture('DEMO/TABLE/01');
  const delivery = base.items[0];
  assert.ok(delivery);
  const data = deliveryListSchema.parse({ ...base, items: [{
    ...delivery,
    source: { ...delivery.source, estimatedMinutes: 120,
      salesOrders: [{ id: 1, name: 'SO/ONE' }, { id: 2, name: 'SO/TWO' }],
      items: delivery.source.items.map((item) => ({ ...item, saleOrderId: 1 })),
      customer: { ...delivery.source.customer, name: 'Synthetic customer', address: 'Via sintetica 12', city: 'Catania' },
    },
    geography: { city: 'Catania', province: 'CT', postalCode: '00100', source: 'synthetic_fixture' },
    servicePlan: { defaultService: 'installation_only', overrides: [] },
    planning: summary,
  }] });
  const item = data.items[0];
  assert.ok(item);
  return item;
}

function tableRow(document: Document, index = 0) {
  assert.ok(document.defaultView);
  const row = document.querySelectorAll('tbody tr')[index];
  assert.ok(row instanceof document.defaultView.HTMLTableRowElement);
  return row;
}

function cell(document: Document, heading: string, rowIndex = 0) {
  const index = Array.from(document.querySelectorAll('thead th')).findIndex((header) => header.textContent === heading);
  assert.notEqual(index, -1, `Missing table heading: ${heading}`);
  const value = tableRow(document, rowIndex).cells[index];
  assert.ok(value);
  return value;
}

void test('delivery list shows required planning fields and remaining estimate without treating historical teams or dates as current', async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const { DeliveryListTable } = await import('../src/components/delivery-list-table');
    const item = rowFixture(planning({ status: 'partially_completed' }));
    item.appointments = ['completed', 'cancelled', 'failed'].map((status, index) => ({
      id: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      startsAt: '2026-10-01T07:00:00Z', endsAt: '2026-10-01T08:00:00Z',
      status: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed',
      cancellationReason: null, returnRequestId: null, results: [],
      assignments: [{ id: firstVisitId, crewId, crewName: 'Historical crew only', people: [], tasks: [] }],
    }));
    const opened: string[] = [];
    await page.render(createElement(DeliveryListTable, { items: [item], selected: null, onOpen: (id) => { opened.push(id); } }));
    const document = page.dom.window.document;
    assert.match(cell(document, 'Delivery / sales orders').textContent ?? '', /DEMO\/TABLE\/01.*SO\/ONE, SO\/TWO/);
    assert.match(cell(document, 'Customer & destination').textContent ?? '', /Synthetic customer.*Via sintetica 12.*Catania, CT, 00100, IT/);
    assert.match(cell(document, 'Customer & destination').textContent ?? '', /Product services\s*Installation only$/);
    assert.equal(cell(document, 'Delivery status').textContent, 'partially completedAssigned teamsNot assigned');
    assert.equal(cell(document, 'Scheduled visit').textContent, 'Not scheduled');
    assert.match(cell(document, 'Remaining work').textContent ?? '', /≈ 30 min.*Provisional proportional estimate.*Original source estimate: 120 min/);
    assert.match(cell(document, 'Source').textContent ?? '', /Imported.*Odoo/);
    assert.doesNotMatch(tableRow(document).textContent ?? '', /Historical crew only|01 Oct|2026-10-01/);
    assert.match(document.body.textContent ?? '', /excludes travel/);
    await click(button(document, 'DEMO/TABLE/01'));
    const openIcon = document.querySelector('button[aria-label="Open DEMO/TABLE/01"]');
    assert.ok(openIcon instanceof HTMLButtonElement);
    await click(openIcon);
    assert.deepEqual(opened, [item.id, item.id]);
    assert.deepEqual(api.calls, []);
  } finally { await page.close(); }
});

void test('Inbox shows product services and a second line only for a differing known default', async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const { DeliveryListTable } = await import('../src/components/delivery-list-table');
    const override = rowFixture();
    const [product] = override.source.items;
    assert.ok(product);
    const overrides = [{ sourceLineId: product.sourceLineId, service: 'delivery_only' as const }];
    override.servicePlan = { defaultService: 'installation_only', overrides };
    const mixed = { ...override, id: firstVisitId, source: {
      ...override.source, items: [product, { ...product, sourceLineId: product.sourceLineId + 1 }],
    } };
    const unknownDefault = { ...override, id: secondVisitId, servicePlan: { defaultService: null, overrides } };
    const props = { items: [override, mixed, unknownDefault], selected: null, onOpen: () => undefined };
    await page.render(createElement(DeliveryListTable, { ...props, view: 'inbox' }));
    const document = page.dom.window.document;
    assert.match(cell(document, 'Customer & destination', 0).textContent ?? '',
      /Product services\s*Delivery only\s*Default service\s*·\s*Installation only$/);
    assert.match(cell(document, 'Customer & destination', 1).textContent ?? '',
      /Product services\s*Mixed services\s*Default service\s*·\s*Installation only$/);
    assert.match(cell(document, 'Customer & destination', 2).textContent ?? '', /Product services\s*Delivery only$/);

    await page.render(createElement(DeliveryListTable, { ...props, view: 'planned' }));
    assert.match(cell(document, 'Customer & destination', 0).textContent ?? '', /Service\s*Delivery only$/);
  } finally { await page.close(); }
});

void test('multiple active visits expose each date and team while refresh preserves the row, disclosure and horizontal scroll', async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const { DeliveryListTable } = await import('../src/components/delivery-list-table');
    const item = rowFixture(planning({ status: 'in_progress', activeVisits: [
      { id: firstVisitId, status: 'in_progress', startsAt: '2026-11-09T08:00:00Z', endsAt: '2026-11-09T10:00:00Z', crews: [{ id: crewId, name: 'Catania Uno' }] },
      { id: secondVisitId, status: 'booked', startsAt: '2026-11-11T13:00:00Z', endsAt: '2026-11-11T15:00:00Z', crews: [{ id: crewId, name: 'Catania Uno' }, { id: otherCrewId, name: 'Assembly Studio' }] },
    ] }));
    const onOpen = () => undefined;
    await page.render(createElement(DeliveryListTable, { items: [item], selected: item.id, onOpen }));
    const document = page.dom.window.document;
    const row = tableRow(document);
    assert.equal(row.className, 'row-selected');
    assert.deepEqual(Array.from(cell(document, 'Delivery status').querySelectorAll('li'), (entry) => entry.textContent), ['Catania Uno', 'Assembly Studio']);
    const scheduled = cell(document, 'Scheduled visit');
    assert.match(scheduled.textContent ?? '', /2 active visits/);
    assert.match(scheduled.textContent ?? '', /09 Nov 2026, 09:00 UTC\+01:00/);
    assert.equal(scheduled.querySelector('time')?.dateTime, '2026-11-09T08:00:00Z');
    const details = scheduled.querySelector('details');
    const scroll = document.querySelector('.table-wrap');
    assert.ok(details && scroll);
    details.open = true;
    scroll.scrollLeft = 264;
    assert.deepEqual(Array.from(details.querySelectorAll('time'), (time) => time.dateTime), ['2026-11-09T08:00:00Z', '2026-11-09T10:00:00Z', '2026-11-11T13:00:00Z', '2026-11-11T15:00:00Z']);
    const updated = rowFixture(planning({ ...item.planning, remainingWorkEstimate: { minutes: 15, basis: 'proportional_remaining_operations', sourceMinutes: 120 } }));
    await page.render(createElement(DeliveryListTable, { items: [updated], selected: item.id, onOpen }));
    assert.equal(tableRow(document), row);
    assert.equal(cell(document, 'Scheduled visit').querySelector('details'), details);
    assert.equal(details.open, true);
    assert.equal(document.querySelector('.table-wrap'), scroll);
    assert.equal(scroll.scrollLeft, 264);
    assert.match(cell(document, 'Remaining work').textContent ?? '', /≈ 15 min/);
  } finally { await page.close(); }
});

void test('zero remaining work, unknown estimates and older responses without planning remain distinct', async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const { DeliveryListTable } = await import('../src/components/delivery-list-table');
    const zero = rowFixture(planning({ status: 'awaiting_closure', remainingWorkEstimate: { minutes: 0, basis: 'no_remaining_work', sourceMinutes: 120 } }));
    const unknown = rowFixture(planning({ remainingWorkEstimate: { minutes: null, basis: 'unknown', sourceMinutes: 120 } }));
    unknown.id = otherCrewId;
    const legacy = rowFixture();
    legacy.id = secondVisitId;
    delete legacy.planning;
    await page.render(createElement(DeliveryListTable, { items: [zero, unknown, legacy], selected: null, onOpen: () => undefined }));
    const document = page.dom.window.document;
    assert.match(cell(document, 'Remaining work', 0).textContent ?? '', /^0 minNo remaining quantities/);
    assert.doesNotMatch(cell(document, 'Remaining work', 0).textContent ?? '', /≈|Provisional/);
    assert.match(cell(document, 'Delivery status', 0).textContent ?? '', /Awaiting closure/);
    assert.match(cell(document, 'Remaining work', 1).textContent ?? '', /^Estimate unavailable.*Original source estimate: 120 min/);
    assert.equal(cell(document, 'Delivery status', 2).textContent, 'Planning data unavailableAssigned teamsPlanning data unavailable');
    assert.equal(cell(document, 'Scheduled visit', 2).textContent, 'Planning data unavailable');
    assert.equal(cell(document, 'Remaining work', 2).textContent, 'Estimate unavailable');
  } finally { await page.close(); }
});

void test('planning columns and empty states are translated without remounting the delivery row', async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const { DeliveryListTable } = await import('../src/components/delivery-list-table');
    const view = createElement(DeliveryListTable, { items: [rowFixture()], selected: null, onOpen: () => undefined });
    await page.render(view);
    const document = page.dom.window.document;
    const row = tableRow(document);
    for (const [locale, status, teams, empty, scheduled] of [
      ['it', 'Stato consegna', 'Squadre assegnate', 'Non assegnata', 'Non pianificata'],
      ['ru', 'Статус доставки', 'Назначенные бригады', 'Не назначены', 'Не запланирован'],
      ['uz', 'Yetkazib berish holati', 'Tayinlangan brigadalar', 'Tayinlanmagan', 'Rejalashtirilmagan'],
      ['en', 'Delivery status', 'Assigned teams', 'Not assigned', 'Not scheduled'],
    ] as const) {
      await page.render(view, locale);
      assert.equal(tableRow(document), row);
      assert.ok(cell(document, status).textContent);
      assert.ok(cell(document, status).textContent?.includes(`${teams}${empty}`));
      assert.ok(row.textContent?.includes(scheduled));
      assert.doesNotMatch(document.body.textContent ?? '', /deliveryList\./);
    }
  } finally { await page.close(); }
});
