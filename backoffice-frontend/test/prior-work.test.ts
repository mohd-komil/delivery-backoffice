import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { act, createElement } from 'react';
import { detailSchema, priorWorkLineSchema, priorWorkRevisionSchema, type DeliveryDetail, type PriorWorkLine } from '../src/lib/contracts';
import { priorQuantityInputSchema, priorWorkInputSchema } from '../src/lib/prior-work';
import { routeJobSchema } from '../src/lib/route-drafts';
import { en, it, ru, uz } from '../src/i18n/messages/prior-work';
import { ApiFixture, button, click, deliveryId, detailFixture, domHarness, editInput, hasToast, user, waitFor } from './refresh-fixtures';

const endpoint = `/deliveries/${deliveryId}/prior-work`;
function priorLine(sourceLineId: number, change: Partial<PriorWorkLine> = {}): PriorWorkLine {
  return priorWorkLineSchema.parse({ sourceLineId, status: 'unknown', canEdit: true, blockedReason: null,
    priorDeliveredMilli: 0, priorInstalledMilli: 0, priorCollectedMilli: 0,
    crewDeliveredMilli: 0, crewInstalledMilli: 0, crewCollectedMilli: 0, current: null, ...change });
}
function twoOrders(): DeliveryDetail {
  const detail = detailFixture();
  const item = detail.delivery.source.items[0]; const line = detail.lineServices?.[0]; assert.ok(item && line);
  detail.delivery.source.salesOrders = [{ id: 1, name: 'ORDER ONE' }, { id: 2, name: 'ORDER TWO' }];
  detail.delivery.source.items = [{ ...item, name: 'Same table', sku: 'SAME-SKU', quantity: 2, saleOrderId: 1 },
    { ...item, sourceLineId: 20, name: 'Same table', sku: 'SAME-SKU', quantity: 2, saleOrderId: 2 }];
  detail.lineServices = [10, 20].map((sourceLineId) => ({ ...line, sourceLineId, service: 'delivery_installation',
    totalDeliveryMilli: 2000, totalInstallationMilli: 2000, remainingDeliveryMilli: 2000, remainingInstallationMilli: 2000,
    availableDeliveryMilli: 2000, availableInstallationMilli: 2000 }));
  detail.priorWork = { lines: [priorLine(10), priorLine(20)], reviewRequired: false };
  return detailSchema.parse(detail);
}
function record() {
  const item = twoOrders().delivery.source.items[0]; assert.ok(item);
  return priorWorkRevisionSchema.parse({ id: randomUUID(), revision: 1, sourceLineId: 10, pickingId: 1, pickingName: 'ORIGINAL/PICKING',
    saleOrderId: 1, saleOrderName: 'ORDER ONE', sourceItem: item, service: 'delivery_installation', deliveredMilli: 1000, installedMilli: 0, collectedMilli: 0,
    sourceReference: 'Signed note 42 <b>source</b>', reason: 'Checked warehouse copy <script>unsafe</script>', acknowledgeCurrentPicking: true,
    confirmedAt: '2026-11-12T13:00:00Z', confirmedBy: { id: user.id, name: 'Francesca' } });
}
function input(scope: ParentNode, name: string): HTMLInputElement {
  const entry = scope.querySelector(`input[name="${name}"]`); assert.ok(entry instanceof HTMLInputElement); return entry;
}
function product(document: Document, order: string): HTMLElement {
  const entry = Array.from(document.querySelectorAll('.product-row')).find((row) => row.textContent?.includes(order));
  assert.ok(entry instanceof HTMLElement); return entry;
}
function form(scope: ParentNode): HTMLFormElement {
  const entry = button(scope, en.save).closest('form'); assert.ok(entry instanceof HTMLFormElement); return entry;
}
async function submit(entry: HTMLFormElement) {
  await act(async () => { entry.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
async function fill(entry: HTMLFormElement) {
  await editInput(input(entry, 'deliveredMilli'), '1'); await editInput(input(entry, 'installedMilli'), '0');
  await editInput(input(entry, 'sourceReference'), 'Signed note 42');
  const reason = entry.querySelector('textarea'); assert.ok(reason);
  await act(async () => { reason.value = 'Warehouse copy checked for this exact move'; reason.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { input(entry, 'acknowledgeCurrentPicking').click(); });
}
async function open(api: ApiFixture) {
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onChanged: () => undefined, onClose: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.product-row') !== null, 'earlier-work product lines');
    return { page, document };
  } catch (failure: unknown) { await page.close(); throw failure; }
}

void test('earlier-work input requires explicit quantities, source and picking acknowledgement', () => {
  for (const value of ['', ' ', '-1', '0.0001', 'NaN', '1e3']) assert.equal(priorQuantityInputSchema.safeParse(value).success, false);
  assert.equal(priorQuantityInputSchema.parse('0'), 0); assert.equal(priorQuantityInputSchema.parse('1.125'), 1125);
  const body = { version: 1, requestId: randomUUID(), sourceLineId: 10, deliveredMilli: 1000, installedMilli: 0, collectedMilli: 0,
    sourceReference: 'Note 42', reason: 'Warehouse confirmed the exact move', acknowledgeCurrentPicking: true };
  assert.equal(priorWorkInputSchema.safeParse(body).success, true);
  for (const change of [{ sourceReference: ' ' }, { reason: '' }, { acknowledgeCurrentPicking: false }, { requestId: 'bad' }, { deliveredMilli: 0.1 }]) {
    assert.equal(priorWorkInputSchema.safeParse({ ...body, ...change }).success, false);
  }
  assert.equal(Object.hasOwn(detailSchema.parse(detailFixture()), 'priorWork'), false, 'older responses remain readable');
  const job = routeJobSchema.parse({ deliveryId, pickingName: 'PICKING', orderNames: ['ORDER ONE'], customerName: 'Test',
    address: null, city: null, point: null, distanceKm: null, suggestedWorkMinutes: null, planningStatus: 'unavailable',
    workReviewReason: 'prior_work_review', hasAvailableRemaining: false, remaining: [] });
  assert.equal(job.workReviewReason, 'prior_work_review', 'Nearby and Routes retain a prior-work blocker instead of rejecting the entire response');
});

void test('same-SKU order lines remain separate; identical failed request retries with its original requestId', async () => {
  const api = new ApiFixture(); api.detail = twoOrders(); const { page, document } = await open(api);
  try {
    const first = product(document, 'ORDER ONE'); const second = product(document, 'ORDER TWO');
    assert.ok(first.textContent?.includes(en.unknownHint));
    await click(button(first, en.edit)); await click(button(second, en.edit));
    const firstForm = form(first); const secondForm = form(second);
    assert.ok(firstForm.parentElement?.textContent?.includes(en.warning));
    await click(button(firstForm, en.save)); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false, 'required fields block empty save');
    await fill(firstForm); await editInput(input(secondForm, 'sourceReference'), 'Unsaved reference for order two');
    const fail = api.defer(endpoint, 'PATCH'); await submit(firstForm); await submit(firstForm);
    assert.equal(api.calls.filter((call) => call.pathname === endpoint).length, 1, 'in-flight duplicate suppressed');
    const firstBody = priorWorkInputSchema.parse(api.calls.find((call) => call.pathname === endpoint)?.body);
    assert.equal(firstBody.sourceLineId, 10); assert.equal(firstBody.deliveredMilli, 1000); assert.equal(firstBody.collectedMilli, 0);
    await act(async () => { fail.reply({ message: 'Temporary network failure' }, 503); });
    await waitFor(() => !button(firstForm, en.save).disabled, 'failed save can retry');
    const success = api.defer(endpoint, 'PATCH'); await submit(firstForm);
    const writes = api.calls.filter((call) => call.pathname === endpoint);
    assert.deepEqual(writes[1]?.body, firstBody, 'unknown outcome retry has identical body and idempotency key');
    const current = record(); const next = twoOrders(); next.delivery.version = 2;
    next.priorWork = { reviewRequired: false, lines: [priorLine(10, { status: 'confirmed', current, priorDeliveredMilli: 1000 }), priorLine(20)] };
    const firstLine = next.lineServices?.[0]; assert.ok(firstLine); firstLine.deliveredMilli = 1000; firstLine.remainingDeliveryMilli = 1000;
    api.detail = next; await act(async () => { success.reply(next); });
    await waitFor(() => hasToast(document, en.saved), 'confirmation toast');
    assert.ok(first.textContent?.includes(en.confirmed)); assert.ok(first.textContent?.includes('Francesca'));
    assert.equal(input(secondForm, 'sourceReference').value, 'Unsaved reference for order two');
    assert.ok(secondForm.textContent?.includes('Use latest data'), 'other line draft must review its stale version');
    assert.equal(second.textContent?.includes('Signed note 42'), false);
  } finally { await page.close(); }
});

void test('Refresh preserves earlier-work inputs, focus and scroll but blocks a stale save', async () => {
  const api = new ApiFixture(); api.detail = twoOrders(); const { page, document } = await open(api);
  try {
    const first = product(document, 'ORDER ONE'); await click(button(first, en.edit)); const editor = form(first); await fill(editor);
    const field = input(editor, 'sourceReference'); const panel = document.querySelector('.delivery-panel'); assert.ok(panel instanceof HTMLElement);
    field.focus(); panel.scrollTop = 192;
    const refresh = api.defer(`/deliveries/${deliveryId}`); await click(button(document, '↻ Refresh')); field.focus();
    const next = twoOrders(); next.delivery.version = 2; api.detail = next;
    await act(async () => { refresh.reply(next); });
    await waitFor(() => editor.textContent?.includes('Use latest data') === true, 'new version guard');
    assert.equal(input(editor, 'sourceReference'), field); assert.equal(field.value, 'Signed note 42');
    assert.equal(document.activeElement, field); assert.equal(panel.scrollTop, 192);
    assert.equal(input(editor, 'acknowledgeCurrentPicking').checked, true);
    await submit(editor); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    await click(button(editor, 'Use latest data'));
    assert.equal(input(editor, 'sourceReference').value, ''); assert.equal(input(editor, 'acknowledgeCurrentPicking').checked, false);
  } finally { await page.close(); }
});

void test('History renders frozen order, quantities and provenance as text in four languages; server lock forbids editing', async () => {
  const api = new ApiFixture(); const page = await domHarness(api);
  try {
    const { DeliveryPriorWork, PriorWorkHistory } = await import('../src/components/delivery-prior-work');
    const current = record(); const line = twoOrders().lineServices?.[0]; assert.ok(line);
    let commands = 0;
    for (const [locale, messages] of [['en', en], ['it', it], ['ru', ru], ['uz', uz]] as const) {
      await page.render(createElement(PriorWorkHistory, { details: { previous: null, current } }), locale);
      assert.ok(page.container.textContent?.includes('ORIGINAL/PICKING')); assert.ok(page.container.textContent?.includes('ORDER ONE'));
      assert.ok(page.container.textContent?.includes(messages.source)); assert.ok(page.container.textContent?.includes(current.reason));
      assert.equal(page.container.querySelector('script,b,form'), null);
      await page.render(createElement(DeliveryPriorWork, { line, history: priorLine(10, { status: 'needs_review', current, canEdit: false, blockedReason: 'recorded_work', crewDeliveredMilli: 1000 }),
        unit: 'unit', label: 'ORDER ONE', version: 1, save: async () => { commands++; return 2; } }), locale);
      assert.ok(page.container.textContent?.includes(messages.recorded_work)); assert.ok(page.container.textContent?.includes(messages.stale));
      assert.ok(page.container.textContent?.includes(messages.crew)); assert.equal(page.container.querySelector('button,input,form'), null);
    }
    assert.equal(commands, 0);
  } finally { await page.close(); }
});
