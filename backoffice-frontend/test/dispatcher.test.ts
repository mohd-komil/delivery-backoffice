import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { act, createElement } from 'react';
import { dispatcherCaseSchema, dispatcherDetailSchema, dispatcherListSchema, dispatcherQuery, dispatcherUpdateSchema, type DispatcherCase, type DispatcherDetail } from '../src/lib/dispatcher';
import type { DeliveryFocus, DeliveryTab } from '../src/lib/contracts';
import { en, it, ru, uz } from '../src/i18n/messages/dispatcher';
import { ApiFixture, button, click, deliveryId, domHarness, hasToast, user, waitFor } from './refresh-fixtures';

const caseKey = 'a'.repeat(64);
const endpoint = `/dispatcher/queue/${caseKey}`;
const warehouseOwner = { id: '70000000-0000-4000-8000-000000000003', name: 'Warehouse coordinator' };
function issueCase(change: Partial<DispatcherCase> = {}): DispatcherCase {
  return dispatcherCaseSchema.parse({ key: caseKey, kind: 'issue', fingerprint: 'b'.repeat(64), title: 'Resolve the reported problem', description: 'Damage to the second order table',
    origin: { deliveryId, routeId: null, appointmentId: '70000000-0000-4000-8000-000000000004', sourceLineId: 20, issueId: '70000000-0000-4000-8000-000000000005', resultId: null, cargoKind: null },
    pickingName: 'PICKING SECOND', customerName: 'Customer', orderName: 'ORDER SECOND', productName: 'Same table · SAME-SKU', quantityMilli: 1000, uom: 'unit',
    reasons: ['issue_damage'], facts: [{ label: 'issue_status', value: 'open' }], sourceOwner: null, sourceAction: null,
    target: { section: 'deliveries', deliveryId, routeId: null, tab: 'issues' },
    status: 'open', version: 0, owner: null, ownerSource: 'unassigned', nextAction: null, note: null, updatedAt: null, updatedBy: null, coordinationStale: false, ...change });
}
function detail(item = issueCase()): DispatcherDetail { return dispatcherDetailSchema.parse({ item, history: [] }); }
function install(api: ApiFixture, item = issueCase(), page = 1, total = 1) {
  api.dispatcherList = dispatcherListSchema.parse({ items: [item], page, pageSize: 10, total,
    counts: { open: total, resolved: 2, kinds: { source_review: 0, address_review: 0, issue: total, evidence: 0, cargo: 0 } } });
  api.dispatcherDetails.set(endpoint, detail(item)); api.dispatcherOwners = [{ id: user.id, name: user.name }, warehouseOwner];
}
function area(scope: ParentNode, name: string): HTMLTextAreaElement {
  const element = scope.querySelector(`textarea[name="${name}"]`); assert.ok(element instanceof HTMLTextAreaElement); return element;
}
async function editArea(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; assert.ok(setter);
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function select(element: HTMLSelectElement | undefined, value: string) {
  assert.ok(element); await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function fill(scope: ParentNode) {
  await editArea(area(scope, 'nextAction'), 'Arrange replacement for ORDER SECOND');
  await editArea(area(scope, 'coordinationNote'), 'Checked with supplier <script>not markup</script>');
}
function dialog(scope: ParentNode) { const element = scope.querySelector('[role="dialog"]'); assert.ok(element instanceof HTMLElement); return element; }
async function submit(scope: ParentNode) {
  const form = area(scope, 'coordinationNote').closest('form'); assert.ok(form);
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

void test('queue contracts allow new version zero, require a fact fingerprint and reason, and cannot manually close a derived case', () => {
  const body = { version: 0, requestId: randomUUID(), fingerprint: 'b'.repeat(64), ownerUserId: null, nextAction: 'Call warehouse', note: 'Confirmed by phone' };
  assert.equal(dispatcherUpdateSchema.safeParse(body).success, true);
  for (const change of [{ status: 'resolved' }, { note: ' ' }, { nextAction: '' }, { fingerprint: 'bad' }, { version: -1 }, { ownerUserId: 'invalid' }]) {
    assert.equal(dispatcherUpdateSchema.safeParse({ ...body, ...change }).success, false);
  }
  assert.equal(dispatcherQuery({ status: 'open', kind: 'cargo', owner: 'mine', page: 2 }), 'status=open&kind=cargo&owner=mine&page=2');
  assert.throws(() => dispatcherQuery({ status: 'open', kind: 'all', owner: 'all', page: 0 }));
  assert.equal(issueCase().origin.sourceLineId, 20);
});

void test('queue uses server pagination and combined filters, ignores stale responses, and does no work before first open', async () => {
  const api = new ApiFixture(); install(api, issueCase(), 1, 11); const page = await domHarness(api);
  try {
    const { DispatcherQueue } = await import('../src/components/dispatcher-queue');
    const render = (active: boolean) => page.render(createElement(DispatcherQueue, { active, onOpenDelivery: () => undefined, onOpenRouteDraft: () => undefined }));
    await render(false); assert.equal(api.calls.length, 0);
    await render(true); await waitFor(() => page.container.querySelector('tbody tr') !== null, 'queue page one');
    assert.ok(page.container.textContent?.includes('1–10 of 11')); assert.equal(page.container.querySelectorAll('tbody tr').length, 1, 'only the server response is rendered');
    install(api, issueCase({ pickingName: 'PAGE TWO' }), 2, 11); await click(button(page.container, 'Next'));
    await waitFor(() => page.container.textContent?.includes('PAGE TWO') === true, 'server second page');
    assert.ok(api.calls.some((call) => call.search.includes('page=2')));
    const old = api.defer('/dispatcher/queue'); await click(button(page.container, en.refresh));
    const originalTable = page.container.querySelector('table'); assert.ok(originalTable);
    const choices = page.container.querySelectorAll('select');
    install(api, issueCase({ pickingName: 'CURRENT FILTER' })); await select(choices[1], 'issue');
    await waitFor(() => page.container.textContent?.includes('CURRENT FILTER') === true, 'current filtered response');
    await act(async () => { old.reply(dispatcherListSchema.parse({ ...api.dispatcherList, items: [issueCase({ pickingName: 'STALE PAGE' })], page: 2 })); });
    assert.equal(page.container.textContent?.includes('STALE PAGE'), false); assert.equal(page.container.querySelector('table'), originalTable);
    await select(choices[2], 'mine'); await waitFor(() => !button(page.container, en.refresh).disabled, 'owner filter');
    await select(choices[0], 'all'); await waitFor(() => !button(page.container, en.refresh).disabled, 'status filter');
    const last = api.calls.filter((call) => call.pathname === '/dispatcher/queue').at(-1); assert.ok(last);
    assert.equal(last.search, '?status=all&kind=issue&owner=mine&page=1');
    const calls = api.calls.length; await render(false); assert.equal(api.calls.length, calls);
  } finally { await page.close(); }
});

void test('coordination requires a note, reuses the same command after an uncertain response, and preserves source ownership', async () => {
  const api = new ApiFixture(); const item = issueCase({ kind: 'cargo', sourceOwner: warehouseOwner, sourceAction: 'Count returned packages', owner: warehouseOwner, ownerSource: 'source', nextAction: 'Count returned packages' });
  install(api, item); const page = await domHarness(api); let saved = 0;
  try {
    const { DispatcherCaseDialog } = await import('../src/components/dispatcher-case-dialog');
    await page.render(createElement(DispatcherCaseDialog, { caseKey, refreshKey: 'one', owners: api.dispatcherOwners, onClose: () => undefined, onSaved: () => { saved++; }, onOpenOriginal: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('textarea') !== null, 'coordination form'); const modal = dialog(document);
    assert.ok(modal.textContent?.includes(en.sourceOwner)); assert.ok(modal.textContent?.includes('Count returned packages'));
    await click(button(modal, en.save)); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    await fill(modal); const coordinator = modal.querySelector('select'); assert.ok(coordinator); await select(coordinator, user.id);
    const failed = api.defer(endpoint, 'PATCH'); await submit(modal); await submit(modal);
    const command = dispatcherUpdateSchema.parse(api.calls.find((call) => call.method === 'PATCH')?.body);
    assert.equal(command.version, 0); assert.equal(command.ownerUserId, user.id); assert.equal(command.fingerprint, item.fingerprint);
    assert.equal(api.calls.filter((call) => call.method === 'PATCH').length, 1);
    await act(async () => { failed.reply({ message: 'Temporary failure' }, 503); });
    await waitFor(() => !button(modal, en.save).disabled, 'retry available');
    const success = api.defer(endpoint, 'PATCH'); await submit(modal);
    assert.deepEqual(api.calls.filter((call) => call.method === 'PATCH')[1]?.body, command);
    const updated = detail({ ...item, version: 1, owner: { id: user.id, name: user.name }, ownerSource: 'coordination', nextAction: command.nextAction, note: command.note });
    updated.history = [{ version: 1, at: '2026-11-12T13:00:00Z', actor: user, owner: user, nextAction: command.nextAction, note: command.note, snapshot: item }];
    await act(async () => { success.reply(updated); }); await waitFor(() => hasToast(document, en.saved), 'save toast');
    assert.equal(saved, 1); assert.equal(area(modal, 'coordinationNote').value, '');
    assert.ok(modal.textContent?.includes(warehouseOwner.name), 'cargo workflow owner is still visible separately');
    await click(button(modal, en.history)); assert.ok(modal.textContent?.includes(command.note)); assert.equal(modal.querySelector('script'), null);
    assert.ok(modal.textContent?.includes('ORDER SECOND')); assert.ok(modal.textContent?.includes('Source line 20'));
  } finally { await page.close(); }
});

void test('case Refresh retains draft DOM, focus, scroll and tab; changed facts and changed coordination version require explicit review', async () => {
  const api = new ApiFixture(); install(api); const page = await domHarness(api);
  try {
    const { DispatcherCaseDialog } = await import('../src/components/dispatcher-case-dialog');
    await page.render(createElement(DispatcherCaseDialog, { caseKey, refreshKey: 'one', owners: api.dispatcherOwners, onClose: () => undefined, onSaved: () => undefined, onOpenOriginal: () => undefined }));
    const document = page.dom.window.document; await waitFor(() => document.querySelector('textarea') !== null, 'case'); const modal = dialog(document);
    await fill(modal); const original = area(modal, 'coordinationNote'); original.focus(); modal.scrollTop = 218;
    const read = api.defer(endpoint); await click(button(modal, en.refresh)); original.focus();
    assert.equal(area(modal, 'coordinationNote'), original); assert.equal(button(modal, en.save).disabled, true);
    await act(async () => { read.reply(detail(issueCase({ fingerprint: 'c'.repeat(64) }))); });
    await waitFor(() => modal.textContent?.includes(en.stale) === true, 'changed facts');
    assert.equal(document.activeElement, original); assert.equal(modal.scrollTop, 218); assert.equal(original.value, 'Checked with supplier <script>not markup</script>');
    await submit(modal); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    await click(button(modal, en.latest)); assert.equal(area(modal, 'coordinationNote').value, '');
    await fill(modal); await click(button(modal, en.history)); api.dispatcherDetails.set(endpoint, detail(issueCase({ fingerprint: 'c'.repeat(64), version: 2 })));
    await click(button(modal, en.refresh)); await waitFor(() => modal.textContent?.includes(en.stale) === true, 'changed coordination version');
    assert.equal(button(modal, en.history).getAttribute('aria-pressed'), 'true'); await click(button(modal, en.facts));
    assert.equal(button(modal, en.save).disabled, true); assert.equal(area(modal, 'coordinationNote').value, 'Checked with supplier <script>not markup</script>');
    await click(button(modal, en.latest)); assert.equal(area(modal, 'coordinationNote').value, '');
  } finally { await page.close(); }
});

void test('opening the exact original workflow preserves queue filters and unsaved coordination when returning', async () => {
  const api = new ApiFixture(); install(api); const page = await domHarness(api);
  const opened: Array<{ id: string; tab: DeliveryTab | undefined; focus: DeliveryFocus | undefined }> = [];
  const routes: string[] = [];
  try {
    const { DispatcherQueue } = await import('../src/components/dispatcher-queue');
    const render = (active: boolean) => page.render(createElement(DispatcherQueue, { active,
      onOpenDelivery: (id, tab, focus) => { opened.push({ id, tab, focus }); }, onOpenRouteDraft: (id) => { routes.push(id); } }));
    await render(true); await waitFor(() => page.container.querySelector('tbody button') !== null, 'queue');
    await select(page.container.querySelectorAll('select')[2], 'mine'); await waitFor(() => !button(page.container, en.refresh).disabled, 'mine filter');
    const row = page.container.querySelector('tbody'); assert.ok(row); await click(button(row, en.issue));
    const document = page.dom.window.document; await waitFor(() => document.querySelector('textarea') !== null, 'case');
    await fill(dialog(document)); await click(button(dialog(document), en.openIssues));
    assert.equal(opened[0]?.id, deliveryId); assert.equal(opened[0]?.tab, 'issues'); assert.equal(opened[0]?.focus?.sourceLineId, 20); assert.equal(opened[0]?.focus?.issueId, issueCase().origin.issueId);
    await render(false); assert.equal(document.querySelector('[role="dialog"]'), null);
    const requests = api.calls.length; await render(false); assert.equal(api.calls.length, requests, 'no hidden polling');
    await render(true); await waitFor(() => document.querySelector('textarea') !== null && !button(dialog(document), en.save).disabled, 'return to queue');
    assert.equal(area(dialog(document), 'coordinationNote').value, 'Checked with supplier <script>not markup</script>');
    assert.equal(page.container.querySelectorAll('select')[2]?.value, 'mine');
    const routeId = randomUUID(); api.dispatcherDetails.set(endpoint, detail(issueCase({ target: { section: 'routes', deliveryId, routeId, tab: null } })));
    await click(button(dialog(document), en.refresh)); await waitFor(() => dialog(document).textContent?.includes(en.openRoute) === true, 'route origin');
    await click(button(dialog(document), en.openRoute)); assert.deepEqual(routes, [routeId]);
  } finally { await page.close(); }
});

void test('resolved cases stay read-only and show translated reason labels and immutable history in all four locales', async () => {
  const api = new ApiFixture(); install(api); const frozen = issueCase({ orderName: 'ORIGINAL ORDER', productName: 'Original table · SAME-SKU' });
  const record = detail(issueCase({ status: 'resolved', version: 1 }));
  record.history = [{ version: 1, at: '2026-11-12T13:00:00Z', actor: user, owner: null, nextAction: 'Check replacement', note: '<b>Original reason</b>', snapshot: frozen }];
  api.dispatcherDetails.set(endpoint, record); const page = await domHarness(api);
  try {
    const { DispatcherCaseDialog } = await import('../src/components/dispatcher-case-dialog');
    for (const [locale, labels] of [['en', en], ['it', it], ['ru', ru], ['uz', uz]] as const) {
      await page.render(createElement(DispatcherCaseDialog, { key: locale, caseKey, refreshKey: locale, owners: [], onClose: () => undefined, onSaved: () => undefined, onOpenOriginal: () => undefined }), locale);
      const document = page.dom.window.document; await waitFor(() => document.querySelector('textarea') !== null, 'localized case'); const modal = dialog(document);
      assert.ok(modal.textContent?.includes(labels.resolvedHelp)); assert.ok(modal.textContent?.includes(labels.issue_damage)); assert.ok(modal.textContent?.includes(labels.derivedHelp));
      assert.equal(button(modal, labels.save).disabled, true); await submit(modal); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
      await click(button(modal, labels.history)); assert.ok(modal.textContent?.includes('ORIGINAL ORDER')); assert.ok(modal.textContent?.includes('<b>Original reason</b>')); assert.equal(modal.querySelector('b'), null);
    }
  } finally { await page.close(); }
});

void test('delivery origin focus opens the correct same-SKU line once and Refresh does not steal focus', async () => {
  const api = new ApiFixture(); const first = api.detail.delivery.source.items[0]; assert.ok(first);
  api.detail.delivery.source.items.push({ ...first, sourceLineId: 20, saleOrderId: 2, name: 'Second order same SKU' });
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, initialTab: 'overview', initialFocus: { sourceLineId: 20, appointmentId: null, issueId: null }, onChanged: () => undefined, onClose: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.activeElement?.id === 'product-line-20', 'exact source line focus');
    const field = document.querySelector('textarea'); assert.ok(field instanceof HTMLTextAreaElement); field.focus();
    const panel = document.querySelector('.delivery-panel'); assert.ok(panel instanceof HTMLElement); panel.scrollTop = 111;
    await click(button(panel, '↻ Refresh')); field.focus();
    await waitFor(() => !button(panel, '↻ Refresh').disabled, 'refreshed detail');
    assert.equal(document.activeElement, field); assert.equal(panel.scrollTop, 111);
  } finally { await page.close(); }
});
