import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { act, createElement } from 'react';
import { detailSchema, type DeliveryDetail } from '../src/lib/contracts';
import { sourceChangeValue, sourceReviewInputSchema, sourceReviewSchema, type SourceReview } from '../src/lib/source-review';
import { en, it, ru, uz } from '../src/i18n/messages/source-review';
import { ApiFixture, button, click, deliveryId, detailFixture, domHarness, hasToast, user, waitFor } from './refresh-fixtures';

const endpoint = `/deliveries/${deliveryId}/source-review`;
const candidateId = '70000000-0000-4000-8000-000000000010';
function twoOrders(): DeliveryDetail {
  const detail = detailFixture(); const item = detail.delivery.source.items[0]; assert.ok(item);
  detail.delivery.source.salesOrders = [{ id: 1, name: 'ORDER FIRST' }, { id: 2, name: 'ORDER SECOND' }];
  detail.delivery.source.items = [{ ...item, name: 'Same table', sku: 'SAME-SKU', saleOrderId: 1 }, { ...item, sourceLineId: 20, name: 'Same table', sku: 'SAME-SKU', saleOrderId: 2 }];
  return detailSchema.parse(detail);
}
function pending(change: Partial<SourceReview> = {}): SourceReview {
  return sourceReviewSchema.parse({ deliveryVersion: 1, status: 'needs_reconciliation', revisionCoverage: 'partial', documentCoverage: 'not_mapped',
    acceptedHash: 'a'.repeat(64), candidate: { id: candidateId, hash: 'b'.repeat(64), firstSeenAt: '2026-11-12T13:30:00Z',
      source: twoOrders().delivery.source, qualifies: true, readComplete: true, revisionCoverage: 'unavailable', reasons: ['revision_unverified'],
      changes: [{ kind: 'quantity', sourceLineId: 10, before: '1', after: '2' }, { kind: 'quantity', sourceLineId: 20, before: '1', after: '3' }] },
    canAccept: true, canKeepAccepted: true, blockers: [], ...change });
}
function reason(scope: ParentNode): HTMLTextAreaElement {
  const control = scope.querySelector('textarea[name="sourceDecisionReason"]'); assert.ok(control instanceof HTMLTextAreaElement); return control;
}
function radio(scope: ParentNode, value: string): HTMLInputElement {
  const control = scope.querySelector(`input[name="sourceDecisionAction"][value="${value}"]`); assert.ok(control instanceof HTMLInputElement); return control;
}
async function fill(scope: ParentNode, action: 'accept' | 'keep_accepted' = 'accept') {
  await act(async () => { radio(scope, action).click(); const field = reason(scope); field.value = 'Checked the exact order lines with the warehouse'; field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit(scope: ParentNode) {
  const form = reason(scope).closest('form'); assert.ok(form instanceof HTMLFormElement);
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

void test('source review contracts require candidate identity and reason, and incoming clocks do not become a fake source timestamp', () => {
  const body = { version: 1, requestId: randomUUID(), candidateId, candidateHash: 'b'.repeat(64), action: 'accept', reason: 'Checked invoice lines' };
  assert.equal(sourceReviewInputSchema.safeParse(body).success, true);
  for (const change of [{ candidateHash: 'bad' }, { candidateId: 'bad' }, { reason: ' ' }, { action: 'force' }, { version: 0 }]) {
    assert.equal(sourceReviewInputSchema.safeParse({ ...body, ...change }).success, false);
  }
  assert.equal(pending().candidate?.revisionCoverage, 'unavailable');
  assert.equal(sourceChangeValue('"Old address"'), 'Old address'); assert.equal(sourceChangeValue('<script>bad</script>'), '<script>bad</script>');
  assert.equal(sourceChangeValue('2'), '2'); assert.match(sourceChangeValue('{"city":"Messina"}'), /"city": "Messina"/);
});

void test('source decision compares exact same-SKU order lines and unknown-outcome retry uses the same guarded command', async () => {
  const api = new ApiFixture(); api.detail = twoOrders(); api.defer(endpoint).reply(pending()); const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onChanged: () => undefined, onClose: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('textarea[name="sourceDecisionReason"]') !== null, 'source decision form');
    const section = reason(document).closest('section'); assert.ok(section);
    assert.ok(section.textContent?.includes('ORDER FIRST')); assert.ok(section.textContent?.includes('ORDER SECOND'));
    assert.ok(section.textContent?.includes(en.unavailableCoverage)); assert.ok(section.textContent?.includes(en.clockHelp));
    assert.equal(button(section, en.save).disabled, true, 'no decision is silently preselected');
    await act(async () => { radio(section, 'accept').click(); });
    await click(button(section, en.save)); assert.equal(api.calls.some((call) => call.method === 'POST'), false, 'empty reason cannot submit');
    await fill(section);
    const failure = api.defer(endpoint, 'POST'); await submit(section); await submit(section);
    const command = sourceReviewInputSchema.parse(api.calls.find((call) => call.pathname === endpoint && call.method === 'POST')?.body);
    assert.equal(command.candidateId, candidateId); assert.equal(command.candidateHash, 'b'.repeat(64)); assert.equal(command.version, 1);
    assert.equal(api.calls.filter((call) => call.method === 'POST').length, 1);
    await act(async () => { failure.reply({ message: 'Temporary response failure' }, 503); });
    await waitFor(() => !button(section, en.save).disabled, 'source decision retry');
    const success = api.defer(endpoint, 'POST'); await submit(section);
    assert.deepEqual(api.calls.filter((call) => call.method === 'POST')[1]?.body, command);
    const next = twoOrders(); next.delivery.version = 2; api.detail = next;
    await act(async () => { success.reply(next); });
    await waitFor(() => hasToast(document, en.saved) && document.querySelector('textarea[name="sourceDecisionReason"]') === null, 'accepted decision refresh');
    assert.ok(document.body.textContent?.includes(en.current));
  } finally { await page.close(); }
});

void test('Refresh retains the decision draft, focus and scroll; a new candidate requires explicit review before another command', async () => {
  const api = new ApiFixture(); api.detail = twoOrders(); api.defer(endpoint).reply(pending()); const page = await domHarness(api);
  try {
    const { DeliverySourceReview } = await import('../src/components/delivery-source-review');
    const commands: unknown[] = []; const save = async (body: unknown) => { commands.push(body); return 3; };
    const render = (version: number, refreshKey: string) => page.render(createElement(DeliverySourceReview, { delivery: { ...api.detail.delivery, version }, refreshKey, save }));
    await render(1, 'first'); await waitFor(() => page.container.querySelector('textarea') !== null, 'first candidate');
    await fill(page.container); const original = reason(page.container); original.focus(); page.container.scrollTop = 177;
    const fresh = api.defer(endpoint); await render(2, 'refresh'); original.focus();
    assert.equal(reason(page.container), original); assert.equal(button(page.container, en.save).disabled, true);
    const latest = pending({ deliveryVersion: 2 }); assert.ok(latest.candidate); latest.candidate.id = randomUUID(); latest.candidate.hash = 'c'.repeat(64);
    await act(async () => { fresh.reply(latest); });
    await waitFor(() => page.container.textContent?.includes(en.stale) === true, 'candidate changed');
    assert.equal(reason(page.container), original); assert.equal(original.value, 'Checked the exact order lines with the warehouse');
    assert.equal(page.dom.window.document.activeElement, original); assert.equal(page.container.scrollTop, 177);
    await submit(page.container); assert.equal(commands.length, 0, 'cannot silently accept the latest candidate using an old reason');
    await click(button(page.container, 'Use latest data'));
    assert.equal(reason(page.container).value, ''); assert.equal(radio(page.container, 'accept').checked, false);
    await fill(page.container); await submit(page.container);
    const command = sourceReviewInputSchema.parse(commands[0]); assert.equal(command.version, 2); assert.equal(command.candidateId, latest.candidate.id); assert.equal(command.candidateHash, 'c'.repeat(64));
  } finally { await page.close(); }
});

void test('candidate identity changes and a failed read retain the unsaved decision even without a version change', async () => {
  const api = new ApiFixture(); api.defer(endpoint).reply(pending()); const page = await domHarness(api);
  try {
    const { DeliverySourceReview } = await import('../src/components/delivery-source-review');
    let commands = 0; const save = async () => { commands++; return 2; };
    const render = (refreshKey: string) => page.render(createElement(DeliverySourceReview, { delivery: twoOrders().delivery, refreshKey, save }));
    await render('one'); await waitFor(() => page.container.querySelector('textarea') !== null, 'candidate form'); await fill(page.container, 'keep_accepted');
    const original = reason(page.container);
    const read = api.defer(endpoint); await render('two'); await act(async () => { read.reply({ message: 'Source temporarily unavailable' }, 503); });
    await waitFor(() => page.container.textContent?.includes(en.unavailable) === true, 'read failure');
    assert.equal(reason(page.container), original); assert.equal(radio(page.container, 'keep_accepted').checked, true);
    await submit(page.container); assert.equal(commands, 0);
    const changed = pending(); assert.ok(changed.candidate); changed.candidate.hash = 'd'.repeat(64);
    api.defer(endpoint).reply(changed); await click(button(page.container, en.retry));
    await waitFor(() => page.container.textContent?.includes(en.stale) === true, 'same-version candidate mismatch');
    assert.equal(reason(page.container), original); await submit(page.container); assert.equal(commands, 0);
    await click(button(page.container, en.latest)); assert.equal(reason(page.container).value, '');
  } finally { await page.close(); }
});

void test('a newer source projection cannot authorize a decision against an older accepted Delivery card', async () => {
  const api = new ApiFixture(); api.defer(endpoint).reply(pending({ deliveryVersion: 2 })); const page = await domHarness(api);
  try {
    const { DeliverySourceReview } = await import('../src/components/delivery-source-review');
    let commands = 0; let refreshes = 0; const save = async () => { commands++; return 3; };
    const render = (version: number) => page.render(createElement(DeliverySourceReview, { delivery: { ...twoOrders().delivery, version },
      refreshKey: String(version), save, onRefreshDelivery: () => { refreshes++; } }));
    await render(1); await waitFor(() => page.container.querySelector('textarea') !== null, 'newer source projection');
    await fill(page.container); const draft = reason(page.container); assert.ok(page.container.textContent?.includes(en.deliveryChanged));
    await submit(page.container); assert.equal(commands, 0);
    await click(button(page.container, en.refreshDelivery)); assert.equal(refreshes, 1);
    api.defer(endpoint).reply(pending({ deliveryVersion: 2 })); await render(2);
    await waitFor(() => !button(page.container, en.save).disabled, 'accepted card version caught up');
    assert.equal(reason(page.container), draft); assert.equal(draft.value, 'Checked the exact order lines with the warehouse');
    await submit(page.container); assert.equal(commands, 1);
  } finally { await page.close(); }
});

void test('server blockers disable accepting, allow only the permitted alternative and explain ongoing visits in all four languages', async () => {
  const api = new ApiFixture(); const page = await domHarness(api);
  try {
    const { DeliverySourceReview } = await import('../src/components/delivery-source-review');
    for (const [locale, messages] of [['en', en], ['it', it], ['ru', ru], ['uz', uz]] as const) {
      const review = pending({ canAccept: false, canKeepAccepted: true,
        blockers: [{ code: 'VISIT_IN_PROGRESS', message: 'English server fallback', sourceLineId: null, appointmentId: randomUUID(), routeId: null },
          { code: 'SOURCE_REVISION_REGRESSION', message: 'Some rows are older', sourceLineId: null, appointmentId: null, routeId: null }] });
      assert.ok(review.candidate); review.candidate.changes.push({ kind: 'service', sourceLineId: null, before: '["delivery_only",60]', after: '["delivery_installation",120]' });
      api.defer(endpoint).reply(review);
      await page.render(createElement(DeliverySourceReview, { key: locale, delivery: twoOrders().delivery, refreshKey: locale, save: async () => 2 }), locale);
      await waitFor(() => page.container.querySelector('textarea') !== null, 'localized blocker');
      assert.ok(page.container.textContent?.includes(messages.VISIT_IN_PROGRESS)); assert.ok(page.container.textContent?.includes(messages.inProgress));
      assert.ok(page.container.textContent?.includes(messages.SOURCE_REVISION_REGRESSION));
      assert.ok(page.container.textContent?.includes(messages.serviceChangeHelp), 'accepting source data must not imply that selected services or saved work times will be replaced');
      assert.ok(page.container.textContent?.includes(messages.quantity)); assert.ok(page.container.textContent?.includes(messages.revision_unverified));
      assert.equal(radio(page.container, 'accept').disabled, true); assert.equal(radio(page.container, 'keep_accepted').disabled, false);
      assert.equal(button(page.container, messages.save).disabled, true);
    }
  } finally { await page.close(); }
});

void test('History uses frozen order identities, localizes the decision and renders source text without markup', async () => {
  const api = new ApiFixture(); const detail = twoOrders(); const source = structuredClone(detail.delivery.source);
  detail.delivery.source.items = detail.delivery.source.items.map((item) => ({ ...item, name: 'Current renamed item' }));
  detail.history = [{ id: randomUUID(), actorId: user.id, actorName: 'Francesca', at: '2026-11-12T14:00:00Z', action: 'source.candidate_kept',
    details: { reason: 'Checked with warehouse <script>bad</script>', previousSource: source, proposedSource: source,
      changes: [{ kind: 'line_removed', sourceLineId: 10, before: '"Same table <b>raw</b>"', after: null }, { kind: 'quantity', sourceLineId: 20, before: '1', after: '2' }] } }];
  api.detail = detail; const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onChanged: () => undefined, onClose: () => undefined }));
    await waitFor(() => page.container.querySelector('.product-row') !== null || page.dom.window.document.querySelector('.product-row') !== null, 'detail');
    const document = page.dom.window.document; await click(button(document, 'History'));
    assert.ok(document.body.textContent?.includes(en.eventKept)); const history = document.querySelector('.history-list'); assert.ok(history);
    assert.ok(history.textContent?.includes('ORDER FIRST')); assert.ok(history.textContent?.includes('ORDER SECOND'));
    assert.ok(history.textContent?.includes('Same table')); assert.equal(history.textContent?.includes('Current renamed item'), false);
    assert.ok(history.textContent?.includes('Checked with warehouse <script>bad</script>')); assert.equal(history.querySelector('b,script,form'), null);
  } finally { await page.close(); }
});
