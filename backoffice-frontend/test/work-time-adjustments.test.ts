import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { detailSchema, deliveryListSchema, remainingWorkEstimateSchema, type DeliveryDetail, type RemainingWorkEstimate } from '../src/lib/contracts';
import { allowanceMinutesInputSchema, workTimeAdjustmentsCommandSchema, workTimeAdjustmentsSchema, workTimeFactorInputSchema } from '../src/lib/work-times';
import { routeJobSchema } from '../src/lib/route-drafts';
import { en, it, ru, uz } from '../src/i18n/messages/work-time-adjustments';
import { ApiFixture, button, click, deliveryId, detailFixture, domHarness, editInput, hasToast, listFixture, user, waitFor } from './refresh-fixtures';

const endpoint = `/deliveries/${deliveryId}/work-time-adjustments`;
function estimate(overrides: Partial<RemainingWorkEstimate> = {}): RemainingWorkEstimate {
  return remainingWorkEstimateSchema.parse({ minutes: 50, sourceMinutes: null, basis: 'local_operation_rates', calculation: {
    algorithmVersion: 'remaining_work_v2', baseMinutes: 50, factorPercent: null, fixedMinutes: null,
    adjustmentVersion: null, adjustmentStatus: 'not_configured',
  }, ...overrides });
}
function allowances() {
  return workTimeAdjustmentsSchema.parse({ factorPercent: 125, visitMinutes: 5, deliveryMinutes: 4, installationMinutes: 8, collectionMinutes: 0,
    sourceEstimateExcludesAdjustments: false, sourceReference: 'DEMO operator observation', assumptions: 'DEMO site allowance; travel excluded',
    version: 1, contextFingerprint: 'a'.repeat(64), updatedAt: '2026-11-17T12:00:00Z', updatedBy: { id: user.id, name: user.name } });
}
function detail(): DeliveryDetail {
  const result = detailFixture(); result.remainingWorkEstimate = estimate(); return result;
}
function input(scope: ParentNode, name: string): HTMLInputElement {
  const field = scope.querySelector(`input[name="${name}"]`); assert.ok(field instanceof HTMLInputElement); return field;
}
function textarea(scope: ParentNode, name: string): HTMLTextAreaElement {
  const field = scope.querySelector(`textarea[name="${name}"]`); assert.ok(field instanceof HTMLTextAreaElement); return field;
}
function region(document: Document): HTMLElement {
  const result = Array.from(document.querySelectorAll('[role="region"]')).find((node) => node.getAttribute('aria-label') === en.title);
  assert.ok(result instanceof HTMLElement); return result;
}
function form(scope: ParentNode): HTMLFormElement {
  const result = button(scope, en.save).closest('form'); assert.ok(result instanceof HTMLFormElement); return result;
}
async function submit(scope: ParentNode) {
  const editor = scope instanceof HTMLFormElement ? scope : scope.querySelector('form');
  assert.ok(editor instanceof HTMLFormElement);
  await act(async () => { editor.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
async function fill(scope: ParentNode) {
  await editInput(input(scope, 'factorPercent'), '125'); await editInput(input(scope, 'visitMinutes'), '5');
  await editInput(input(scope, 'deliveryMinutes'), '4'); await editInput(input(scope, 'installationMinutes'), '8');
  await editInput(textarea(scope, 'sourceReference'), 'DEMO operator observation');
  await editInput(textarea(scope, 'assumptions'), 'DEMO site allowance; travel excluded');
  await editInput(textarea(scope, 'reason'), 'Review this exact site');
}
async function open(api: ApiFixture) {
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onChanged: () => undefined, onClose: () => undefined }));
    await waitFor(() => page.dom.window.document.querySelector(`[aria-label="${en.title}"]`) !== null, 'remaining-work estimate');
    return page;
  } catch (error: unknown) { await page.close(); throw error; }
}

void test('allowance contracts accept legacy absence, explicit zero and unknown while rejecting invalid time inputs', () => {
  assert.equal(Object.hasOwn(detailSchema.parse(detailFixture()).delivery, 'workTimeAdjustments'), false);
  assert.equal(Object.hasOwn(detailSchema.parse(detailFixture()), 'remainingWorkEstimate'), false);
  assert.equal(allowanceMinutesInputSchema.parse(''), null); assert.equal(allowanceMinutesInputSchema.parse('0'), 0);
  assert.equal(workTimeFactorInputSchema.parse(''), null); assert.equal(workTimeFactorInputSchema.parse('100'), 100);
  for (const value of ['-1', '0.5', '1441', 'Infinity']) assert.equal(allowanceMinutesInputSchema.safeParse(value).success, false);
  for (const value of ['0', '1001', '12.5', 'NaN']) assert.equal(workTimeFactorInputSchema.safeParse(value).success, false);
  const saved = allowances(); const { sourceEstimateExcludesAdjustments, ...legacy } = saved;
  assert.equal(sourceEstimateExcludesAdjustments, false);
  assert.equal(workTimeAdjustmentsSchema.parse(legacy).sourceEstimateExcludesAdjustments, false);
  assert.equal(workTimeAdjustmentsCommandSchema.safeParse({ ...saved, requestId: crypto.randomUUID(), reason: 'Apply', contextFingerprint: undefined }).success, false);
});

void test('allowances require explicit save, retain uncertain retries and display the authoritative server result', async () => {
  const api = new ApiFixture(); api.detail = detail(); const page = await open(api);
  try {
    const document = page.dom.window.document; const section = region(document);
    await click(button(section, en.edit));
    assert.equal(input(section, 'factorPercent').value, '100'); assert.equal(input(section, 'visitMinutes').value, '0');
    assert.ok(section.textContent?.includes(en.defaults)); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    await fill(section);
    const failure = api.defer(endpoint, 'PATCH'); await submit(section); await submit(section);
    assert.equal(api.calls.filter((call) => call.pathname === endpoint).length, 1);
    await act(async () => { failure.reply({ message: 'Response unavailable' }, 503); });
    await waitFor(() => !button(section, en.save).disabled, 'uncertain save settled');
    assert.equal(textarea(section, 'reason').value, 'Review this exact site');
    const response = api.defer(endpoint, 'PATCH'); await submit(section);
    const calls = api.calls.filter((call) => call.pathname === endpoint);
    assert.equal(calls.length, 2); assert.deepEqual(calls[0]?.body, calls[1]?.body);
    const command = workTimeAdjustmentsCommandSchema.parse(calls[1]?.body);
    assert.equal(command.factorPercent, 125); assert.equal(command.installationMinutes, 8); assert.equal(command.collectionMinutes, 0);
    const saved = detail(); saved.delivery.version = 2; saved.delivery.workTimeAdjustments = allowances();
    saved.remainingWorkEstimate = estimate({ minutes: 83, calculation: { algorithmVersion: 'remaining_work_v2', baseMinutes: 50,
      factorPercent: 125, fixedMinutes: 17, adjustmentVersion: 1, adjustmentStatus: 'current' } });
    api.detail = saved; await act(async () => { response.reply(saved); });
    await waitFor(() => hasToast(document, en.saved) && section.textContent?.includes('83 min') === true, 'server total shown without browser recomputation');
    assert.ok(section.textContent?.includes('125%')); assert.ok(section.textContent?.includes('17 min'));
    assert.equal(api.calls.some((call) => call.pathname.endsWith('/work-times')), false);
  } finally { await page.close(); }
});

void test('a source acknowledgement remains available after the server marks the adjusted total unknown and can recover', async () => {
  const api = new ApiFixture(); api.detail = detail(); api.detail.remainingWorkEstimate = estimate({ sourceMinutes: 50, basis: 'mixed_operation_rates' });
  const page = await open(api);
  try {
    const section = region(page.dom.window.document); await click(button(section, en.edit)); await fill(section);
    assert.equal(input(section, 'sourceEstimateExcludesAdjustments').checked, false);
    const missing = api.defer(endpoint, 'PATCH'); await submit(section);
    const next = detail(); next.delivery.version = 2; next.delivery.workTimeAdjustments = allowances();
    next.remainingWorkEstimate = estimate({ minutes: null, sourceMinutes: 50, basis: 'unknown', calculation: {
      algorithmVersion: 'remaining_work_v2', baseMinutes: 50, factorPercent: 125, fixedMinutes: 17,
      adjustmentVersion: 1, adjustmentStatus: 'incomplete', missingFields: ['sourceEstimateExcludesAdjustments'],
    } }); api.detail = next; await act(async () => { missing.reply(next); });
    await waitFor(() => section.textContent?.includes(en.incomplete) === true, 'unknown source allowance explanation');
    const checkbox = input(section, 'sourceEstimateExcludesAdjustments'); assert.equal(checkbox.checked, false);
    await act(async () => { checkbox.click(); });
    const recovery = api.defer(endpoint, 'PATCH'); await submit(section);
    const bodies = api.calls.filter((call) => call.pathname === endpoint).map((call) => workTimeAdjustmentsCommandSchema.parse(call.body));
    assert.equal(bodies[0]?.sourceEstimateExcludesAdjustments, false); assert.equal(bodies[1]?.sourceEstimateExcludesAdjustments, true);
    assert.equal(bodies[1]?.version, 2);
    const recovered = detail(); recovered.delivery.version = 3; recovered.delivery.workTimeAdjustments = { ...allowances(), version: 2, sourceEstimateExcludesAdjustments: true };
    recovered.remainingWorkEstimate = estimate({ minutes: 80, sourceMinutes: 50, basis: 'mixed_operation_rates', calculation: {
      algorithmVersion: 'remaining_work_v2', baseMinutes: 50, factorPercent: 125, fixedMinutes: 17, adjustmentVersion: 2, adjustmentStatus: 'current',
    } }); await act(async () => { recovery.reply(recovered); });
    await waitFor(() => section.textContent?.includes('80 min') === true, 'acknowledged source estimate recovered');
  } finally { await page.close(); }
});

void test('Refresh preserves an allowance draft and focus, guards the old version and loads current inputs only on review', async () => {
  const api = new ApiFixture(); api.detail = detail(); api.detail.delivery.workTimeAdjustments = allowances(); const page = await open(api);
  try {
    const document = page.dom.window.document; const section = region(document); await click(button(section, en.edit));
    const editor = form(section); const factor = input(editor, 'factorPercent'); await editInput(factor, '140');
    await editInput(textarea(editor, 'reason'), 'Unsaved inspection'); factor.focus();
    const read = api.defer(`/deliveries/${deliveryId}`); await click(button(document, '↻ Refresh')); factor.focus();
    const next = detail(); next.delivery.version = 2; next.delivery.workTimeAdjustments = { ...allowances(), factorPercent: 130, version: 2 };
    next.remainingWorkEstimate = estimate({ minutes: null, basis: 'unknown', calculation: { algorithmVersion: 'remaining_work_v2',
      baseMinutes: 50, factorPercent: 130, fixedMinutes: 17, adjustmentVersion: 2, adjustmentStatus: 'needs_review' } });
    api.detail = next; await act(async () => { read.reply(next); });
    await waitFor(() => editor.textContent?.includes('Use latest data') === true, 'stale draft warning');
    assert.equal(form(section), editor); assert.equal(input(editor, 'factorPercent'), factor); assert.equal(factor.value, '140');
    assert.equal(document.activeElement, factor); assert.equal(textarea(editor, 'reason').value, 'Unsaved inspection');
    await submit(section); assert.equal(api.calls.some((call) => call.pathname === endpoint), false);
    await click(button(editor, 'Use latest data')); assert.equal(input(editor, 'factorPercent').value, '130');
    assert.ok(section.textContent?.includes(en.needs_review));
  } finally { await page.close(); }
});

void test('shared Inbox and Nearby/Routes summaries show the same server breakdown, revision and incomplete state in four languages', async () => {
  const api = new ApiFixture(); const page = await domHarness(api);
  try {
    const { DeliveryListTable } = await import('../src/components/delivery-list-table');
    const { JobSummary } = await import('../src/components/route-planning-panels');
    const { DeliveryWorkEstimate } = await import('../src/components/delivery-work-estimate');
    const base = listFixture(); const row = base.items[0]; assert.ok(row);
    const value = estimate({ minutes: null, basis: 'unknown', calculation: { algorithmVersion: 'remaining_work_v2',
      baseMinutes: 30, factorPercent: 125, fixedMinutes: null, adjustmentVersion: 4, adjustmentStatus: 'incomplete', missingFields: ['installationMinutes'] } });
    for (const [locale, messages] of [['en', en], ['it', it], ['ru', ru], ['uz', uz]] as const) {
      const list = deliveryListSchema.parse({ ...base, items: [{ ...row, planning: { status: 'inbox', activeVisits: [], remainingWorkEstimate: value } }] });
      await page.render(createElement(DeliveryListTable, { items: list.items, selected: null, onOpen: () => undefined }), locale);
      let text = page.dom.window.document.body.textContent ?? ''; assert.ok(text.includes(messages.incomplete)); assert.ok(text.includes('125%')); assert.ok(text.includes(messages.revision.replace('{version}', '4')));
      const job = routeJobSchema.parse({ deliveryId, pickingName: 'DEMO/INSTALLATION', orderNames: ['DEMO/SO'], customerName: 'DEMO customer',
        address: 'Synthetic address', city: 'Messina', point: null, distanceKm: null, suggestedWorkMinutes: null, planningStatus: 'unplanned', remaining: [], remainingWorkEstimate: value });
      await page.render(createElement(JobSummary, { job }), locale);
      text = page.dom.window.document.body.textContent ?? ''; assert.ok(text.includes(messages.incomplete)); assert.ok(text.includes(messages.unknown));
      const closed = detailFixture().delivery; closed.completedAt = '2026-11-17T12:00:00Z';
      await page.render(createElement(DeliveryWorkEstimate, { delivery: closed, estimate: value, save: async () => 1 }), locale);
      text = page.dom.window.document.body.textContent ?? ''; assert.ok(text.includes(messages.installationMinutes)); assert.ok(text.includes(messages.locked));
      assert.equal(page.container.querySelector('form'), null);
    }
    assert.equal(api.calls.length, 0);
  } finally { await page.close(); }
});
