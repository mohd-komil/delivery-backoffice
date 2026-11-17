import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { deliveryListSchema, detailSchema, remainingWorkEstimateSchema, type DeliveryDetail } from '../src/lib/contracts';
import { routeJobSchema } from '../src/lib/route-drafts';
import { lineWorkTimeSchema, workTimeRateInputSchema, workTimesInputSchema, type LineWorkTime } from '../src/lib/work-times';
import { ApiError, errorMessage } from '../src/lib/api';
import { en, it, ru, uz } from '../src/i18n/messages/work-times';
import { ApiFixture, button, click, deliveryId, detailFixture, domHarness, editInput, hasToast, listFixture, user, waitFor } from './refresh-fixtures';

const endpoint = `/deliveries/${deliveryId}/work-times`;
function estimate(sourceLineId: number, change: Partial<LineWorkTime> = {}): LineWorkTime {
  return lineWorkTimeSchema.parse({ sourceLineId, deliveryMinutesPerUnit: null, installationMinutesPerUnit: null,
    collectionMinutesPerUnit: null, stale: false, missingOperations: [], remainingMinutes: null, basis: 'unknown',
    localSavedAt: null, localSavedBy: null, canEdit: true, ...change });
}
function twoOrders(): DeliveryDetail {
  const detail = detailFixture();
  const item = detail.delivery.source.items[0];
  const line = detail.lineServices?.[0];
  assert.ok(item && line);
  detail.delivery.source.salesOrders = [{ id: 1, name: 'TEST/SO/FIRST' }, { id: 2, name: 'TEST/SO/SECOND' }];
  detail.delivery.source.items = [{ ...item, name: 'Same product', sku: 'SAME-SKU', quantity: 2, saleOrderId: 1 },
    { ...item, name: 'Same product', sku: 'SAME-SKU', quantity: 2, saleOrderId: 2, sourceLineId: 20 }];
  detail.delivery.servicePlan = { defaultService: 'delivery_installation', defaultOrigin: 'local', overrides: [{ sourceLineId: 20, service: 'collection_only', origin: 'local' }] };
  detail.lineServices = [{ ...line, service: 'delivery_installation', serviceOrigin: 'local',
    totalDeliveryMilli: 2000, totalInstallationMilli: 2000, remainingDeliveryMilli: 2000, remainingInstallationMilli: 2000, availableDeliveryMilli: 2000, availableInstallationMilli: 2000 },
  { ...line, sourceLineId: 20, service: 'collection_only', serviceOrigin: 'local', inherited: false,
    totalDeliveryMilli: 0, totalCollectionMilli: 2000, remainingDeliveryMilli: 0, remainingCollectionMilli: 2000, availableDeliveryMilli: 0, availableCollectionMilli: 2000 }];
  detail.lineWorkTimes = [estimate(10, { missingOperations: ['delivery', 'installation'] }), estimate(20, { missingOperations: ['collection'] })];
  return detailSchema.parse(detail);
}
function local(sourceLineId: number, change: Partial<LineWorkTime> = {}) {
  return estimate(sourceLineId, { localSavedAt: '2026-11-12T11:00:00Z', localSavedBy: { id: user.id, name: user.name }, basis: 'local', ...change });
}
function product(document: Document, order: string): HTMLElement {
  const result = Array.from(document.querySelectorAll('.product-row')).find((entry) => entry.textContent?.includes(order));
  assert.ok(result instanceof HTMLElement); return result;
}
function input(scope: ParentNode, name: string): HTMLInputElement {
  const result = scope.querySelector(`input[name="${name}"]`);
  assert.ok(result instanceof HTMLInputElement); return result;
}
function form(scope: ParentNode): HTMLFormElement {
  const result = button(scope, 'Save work time').closest('form'); assert.ok(result instanceof HTMLFormElement); return result;
}
async function submit(element: HTMLFormElement) {
  await act(async () => { element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
async function open(api: ApiFixture) {
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onChanged: () => undefined, onClose: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.product-row') !== null, 'product-line work times');
    return { page, document };
  } catch (error: unknown) { await page.close(); throw error; }
}

void test('work-time contracts preserve optional legacy absence and distinguish missing, local and provisional source time', () => {
  const legacy = detailFixture();
  assert.equal(Object.hasOwn(detailSchema.parse(legacy), 'lineWorkTimes'), false);
  assert.equal(workTimeRateInputSchema.parse(''), null);
  for (const invalid of ['0', '-2', '0.5', '1441', 'Infinity', 'no time']) assert.equal(workTimeRateInputSchema.safeParse(invalid).success, false);
  assert.equal(workTimeRateInputSchema.parse(' 12 '), 12);
  const detail = twoOrders();
  detail.delivery.servicePlan = { defaultService: 'delivery_installation', defaultOrigin: 'local', overrides: [], timeEstimates: [{
    sourceLineId: 10, deliveryMinutesPerUnit: 10, installationMinutesPerUnit: 30, collectionMinutesPerUnit: null,
    context: { productId: 1, saleOrderId: 1, uom: 'unit', uomId: null, addressKey: 'a'.repeat(64) },
    updatedAt: '2026-11-12T10:00:00Z', updatedBy: { id: user.id, name: user.name },
  }] };
  assert.deepEqual(detailSchema.parse(detail).delivery.servicePlan, detail.delivery.servicePlan);
  assert.equal(lineWorkTimeSchema.safeParse({ ...estimate(10), deliveryMinutesPerUnit: 0 }).success, false);
  assert.equal(lineWorkTimeSchema.safeParse({ ...estimate(10), basis: 'source' }).success, false);
  for (const basis of ['local_operation_rates', 'mixed_operation_rates', 'unknown'] as const) {
    const value = { minutes: null, sourceMinutes: null, basis, missingSourceLineIds: [20], staleSourceLineIds: [10], exceedsLimit: true };
    assert.deepEqual(remainingWorkEstimateSchema.parse(value), value);
  }
});

void test('same-SKU order lines save only their own local team time; server remaining time and other unsaved edits are retained', async () => {
  const api = new ApiFixture(); api.detail = twoOrders();
  api.detail.lineWorkTimes = [local(10, { collectionMinutesPerUnit: 99, basis: 'unknown', missingOperations: ['delivery', 'installation'] }), estimate(20)];
  const { page, document } = await open(api);
  try {
    const first = product(document, 'TEST/SO/FIRST'); const second = product(document, 'TEST/SO/SECOND');
    await click(button(first, 'Edit work time')); await click(button(second, 'Edit work time'));
    const firstForm = form(first); const secondForm = form(second);
    await editInput(input(firstForm, 'deliveryMinutesPerUnit'), '10');
    await editInput(input(firstForm, 'installationMinutesPerUnit'), '35');
    await editInput(input(secondForm, 'collectionMinutesPerUnit'), '33');
    assert.equal(input(firstForm, 'collectionMinutesPerUnit').disabled, true);
    assert.equal(input(firstForm, 'collectionMinutesPerUnit').value, '99', 'retained rate for an old service stays visible but is not submitted for an unavailable operation');
    assert.equal(input(secondForm, 'deliveryMinutesPerUnit').disabled, true);
    assert.match(firstForm.parentElement?.textContent ?? '', /whole team per 1 unit.*not person-hours/);
    const saved = api.defer(endpoint, 'PATCH');
    await submit(firstForm); await submit(firstForm);
    assert.equal(api.calls.filter((call) => call.pathname === endpoint).length, 1);
    assert.deepEqual(workTimesInputSchema.parse(api.calls.find((call) => call.pathname === endpoint)?.body), {
      version: 1, sourceLineId: 10, deliveryMinutesPerUnit: 10, installationMinutesPerUnit: 35, collectionMinutesPerUnit: null,
    });
    const next = twoOrders(); next.delivery.version = 2;
    next.lineWorkTimes = [local(10, { deliveryMinutesPerUnit: 10, installationMinutesPerUnit: 35, remainingMinutes: 97 }), estimate(20, { missingOperations: ['collection'] })];
    api.detail = next;
    await act(async () => { saved.reply(next); });
    await waitFor(() => hasToast(document, en.saved) && first.textContent?.includes('≈ 97 min') === true, 'server estimate, not a client recomputation');
    assert.equal(form(first), firstForm); assert.equal(form(second), secondForm);
    assert.equal(input(secondForm, 'collectionMinutesPerUnit').value, '33');
    assert.ok(secondForm.textContent?.includes('Use latest data'));
    await submit(secondForm);
    assert.equal(api.calls.filter((call) => call.pathname === endpoint).length, 1, 'another line draft cannot silently use a newer aggregate version');
    assert.equal(api.detail.delivery.source.estimatedMinutes, null);
    assert.equal(api.calls.some((call) => call.pathname.endsWith('/services')), false);
    assert.ok(document.body.textContent?.includes(en.sourceTotal));
    assert.ok(first.textContent?.includes(en.serviceLocal));
  } finally { await page.close(); }
});

void test('Refresh keeps a time draft, focus and scroll; explicit latest-data review permits clearing local rates', async () => {
  const api = new ApiFixture(); api.detail = twoOrders();
  api.detail.lineWorkTimes = [local(10, { deliveryMinutesPerUnit: 20, installationMinutesPerUnit: 40, remainingMinutes: 120 }), estimate(20)];
  const { page, document } = await open(api);
  try {
    const row = product(document, 'TEST/SO/FIRST'); await click(button(row, 'Edit work time'));
    const editor = form(row); const rate = input(editor, 'deliveryMinutesPerUnit');
    const panel = document.querySelector('.delivery-panel'); assert.ok(panel instanceof HTMLElement);
    await editInput(rate, '12'); rate.focus(); panel.scrollTop = 164;
    const fresh = api.defer(`/deliveries/${deliveryId}`); await click(button(document, '↻ Refresh')); rate.focus();
    const next = twoOrders(); next.delivery.version = 2;
    next.lineWorkTimes = [local(10, { deliveryMinutesPerUnit: 25, installationMinutesPerUnit: 40, stale: true }), estimate(20)];
    api.detail = next;
    await act(async () => { fresh.reply(next); });
    await waitFor(() => editor.textContent?.includes('Use latest data') === true, 'stale draft guarded');
    assert.equal(input(editor, 'deliveryMinutesPerUnit'), rate); assert.equal(rate.value, '12');
    assert.equal(document.activeElement, rate); assert.equal(panel.scrollTop, 164);
    assert.ok(row.textContent?.includes(en.stale));
    await submit(editor); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    await click(button(editor, 'Use latest data'));
    assert.equal(input(editor, 'deliveryMinutesPerUnit').value, '25');
    await editInput(input(editor, 'deliveryMinutesPerUnit'), ''); await editInput(input(editor, 'installationMinutesPerUnit'), '');
    const save = api.defer(endpoint, 'PATCH'); await submit(editor);
    assert.deepEqual(api.calls.find((call) => call.pathname === endpoint)?.body, { version: 2, sourceLineId: 10,
      deliveryMinutesPerUnit: null, installationMinutesPerUnit: null, collectionMinutesPerUnit: null });
    await act(async () => { save.reply({ message: 'Review the source before changing work times' }, 409); });
    await waitFor(() => editor.textContent?.includes('Review the source before changing work times') === true, 'actionable conflict');
    assert.equal(input(editor, 'deliveryMinutesPerUnit').value, '');
    assert.equal(form(row), editor);
  } finally { await page.close(); }
});

void test('line estimates distinguish provisional source time, mixed time and server locks in all four languages', async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const { DeliveryWorkTime } = await import('../src/components/delivery-work-time');
    const line = twoOrders().lineServices?.[0]; assert.ok(line);
    for (const [locale, messages] of [['en', en], ['it', it], ['ru', ru], ['uz', uz]] as const) {
      await page.render(createElement(DeliveryWorkTime, { line, label: 'TEST/SO/FIRST', unit: 'unit', version: 1,
        estimate: estimate(10, { basis: 'source_total_proportion', remainingMinutes: 60, canEdit: false }), save: async () => 1 }), locale);
      const doc = page.dom.window.document;
      assert.ok(doc.body.textContent?.includes(messages.source)); assert.ok(doc.body.textContent?.includes(messages.sourceHelp));
      assert.ok(doc.body.textContent?.includes(messages.locked)); assert.equal(doc.querySelector('input'), null);
      await page.render(createElement(DeliveryWorkTime, { line, label: 'TEST/SO/FIRST', unit: 'unit', version: 1,
        estimate: local(10, { basis: 'mixed', deliveryMinutesPerUnit: 10, remainingMinutes: 80, canEdit: false }), save: async () => 1 }), locale);
      assert.ok(doc.body.textContent?.includes(messages.mixed)); assert.ok(doc.body.textContent?.includes(messages.mixedHelp));
      if (locale !== 'en') assert.equal(errorMessage(new ApiError(409, 'Select the service before entering work times'), locale), messages.serviceRequired);
    }
    assert.equal(api.calls.length, 0);
  } finally { await page.close(); }
});

void test('Inbox and the shared Nearby/Routes job summary identify local and mixed estimates without relabelling them as road time', async () => {
  const api = new ApiFixture(); const page = await domHarness(api);
  try {
    const { DeliveryListTable } = await import('../src/components/delivery-list-table');
    const { JobSummary } = await import('../src/components/route-planning-panels');
    const base = listFixture(); const delivery = base.items[0]; assert.ok(delivery);
    for (const [locale, messages] of [['en', en], ['it', it], ['ru', ru], ['uz', uz]] as const) {
      for (const basis of ['local_operation_rates', 'mixed_operation_rates'] as const) {
        const remainingWorkEstimate = { minutes: 73, sourceMinutes: basis === 'mixed_operation_rates' ? 120 : null, basis };
        const list = deliveryListSchema.parse({ ...base, items: [{ ...delivery, planning: { status: 'inbox', activeVisits: [], remainingWorkEstimate } }] });
        await page.render(createElement(DeliveryListTable, { items: list.items, selected: null, onOpen: () => undefined }), locale);
        const doc = page.dom.window.document;
        const row = doc.querySelector('tbody tr'); assert.ok(row);
        const expected = messages[basis === 'local_operation_rates' ? 'local' : 'mixed'];
        assert.ok(row.textContent?.includes(expected)); assert.ok(row.textContent?.includes('≈ 73'));
        const job = routeJobSchema.parse({ deliveryId, pickingName: 'TEST/PICKING', orderNames: ['TEST/SO/FIRST'], customerName: 'Test customer',
          address: 'Test address', city: 'Messina', point: null, distanceKm: null, suggestedWorkMinutes: 73, planningStatus: 'unplanned', remaining: [], remainingWorkEstimate });
        await page.render(createElement(JobSummary, { job }), locale);
        assert.ok(doc.body.textContent?.includes(expected));
      }
    }
    assert.equal(api.calls.length, 0);
  } finally { await page.close(); }
});
