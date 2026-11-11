import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { appointmentSchema, participantSchema, templateSchema, workScopeSchema } from '../src/lib/contracts';
import { routeDraftSchema } from '../src/lib/route-drafts';
import { publicationRequestSchema, publicationReviewSchema, publicationSummarySchema } from '../src/lib/route-publication';
import { ApiFixture, button, click, detailFixture, domHarness, editInput, hasToast, waitFor } from './refresh-fixtures';

const routeId = '91000000-0000-4000-8000-000000000001';
const personId = '91000000-0000-4000-8000-000000000002';
const crewId = '91000000-0000-4000-8000-000000000003';
const templateId = '91000000-0000-4000-8000-000000000004';
const visitId = '91000000-0000-4000-8000-000000000005';
const vehicleId = '91000000-0000-4000-8000-000000000006';
const at = '2026-11-16T08:00:00.000Z';
const later = '2026-11-16T09:30:00.000Z';
const detail = detailFixture();
const person = participantSchema.parse({ id: personId, version: 1, name: 'DEMO Marco Rossi', firstName: 'Marco', lastName: 'Rossi',
  preferredName: null, phoneNumber: null, address: null, login: null, external: false, enabled: true, hasPassword: false, skillIds: [] });
const template = templateSchema.parse({ id: templateId, version: 1, title: 'Unload furniture', severity: 'high', order: 0, checklist: ['Inspect packaging'], enabled: true, requiredSkillIds: [] });
const route = routeDraftSchema.parse({ id: routeId, name: 'DEMO publication', version: 1, createdAt: at, updatedAt: at,
  departAt: at, crewId, vehicleId, startPointId: 'depot', endPointId: 'depot', stops: [{ deliveryId: detail.delivery.id, workMinutes: 30 }], manualEstimates: [],
  planning: { participantIds: [personId], participantAvailability: [], vehicleAvailability: null,
    driver: { kind: 'participant', participantId: personId }, transferBufferMinutes: 10 },
  jobs: [], warnings: [], pointContexts: [],
  timeline: { departAt: at, startPointId: 'depot', endPointId: 'depot', returnDepartAt: at, returnAt: later,
    stops: [], returnTravelMinutes: 30, returnTravelSource: 'local_demo', travelMinutes: 60, workMinutes: 30, waitingMinutes: 0, totalMinutes: 90 },
});
const sourceItem = detail.delivery.source.items[0];
assert.ok(sourceItem);
const scope = workScopeSchema.parse({ revision: 1, sourceFingerprint: 'a'.repeat(64), confirmedAt: at, confirmedBy: { id: personId, name: 'DEMO operator' },
  lines: [{ sourceLineId: 10, deliveryMilli: 500, installationMilli: 0, collectionMilli: 0, service: 'delivery_only', sourceItem }] });
function review(enabled: boolean) {
  return publicationReviewSchema.parse({ routeId, draftVersion: 1, fingerprint: 'a'.repeat(64), publicationEnabled: enabled, timeline: route.timeline,
    feasibility: { status: 'feasible_estimate', checkedAt: at, fingerprint: 'b'.repeat(64), findings: [], workDurations: [] },
    stops: [{ deliveryId: detail.delivery.id, pickingName: detail.delivery.source.pickingName, mode: 'create', appointmentId: visitId,
      startsAt: at, endsAt: later, workScope: scope, assignments: [], responsibleParticipant: { id: personId, name: person.name }, customerConfirmationStatus: 'awaiting_customer_confirmation' }] });
}
const summary = publicationSummarySchema.parse({ id: routeId, version: 1, status: 'published', draftVersion: 1, publishedAt: at,
  stops: [{ deliveryId: detail.delivery.id, appointmentId: visitId, source: 'created' }] });

function checkbox(container: ParentNode, text: string) {
  const element = Array.from(container.querySelectorAll('label')).find((label) => label.textContent?.includes(text))?.querySelector('input[type="checkbox"]');
  assert.ok(element instanceof HTMLInputElement, `Missing checkbox ${text}`);
  return element;
}
async function toggle(control: HTMLInputElement) { await act(async () => control.click()); }
async function prepare(page: Awaited<ReturnType<typeof domHarness>>) {
  await click(button(page.container, 'Prepare publication'));
  await waitFor(() => page.container.querySelector('[data-work-line="10"] input') !== null, 'work quantities');
  const quantity = page.container.querySelector('[data-work-line="10"] input');
  assert.ok(quantity instanceof HTMLInputElement);
  await editInput(quantity, '0.5');
  await toggle(checkbox(page.container, template.title));
  return quantity;
}

void test('publication review selects exact work and preserves inputs on Refresh while the stand remains gated', async () => {
  const api = new ApiFixture(); api.templates = [template];
  api.defer('/routes/publication-capability').reply({ enabled: false, reason: 'Lifecycle controls pending' });
  api.defer(`/routes/${routeId}/publication-review`, 'POST').reply(review(false));
  const page = await domHarness(api);
  const published: unknown[] = [];
  const onPublished = (value: unknown) => { published.push(value); };
  try {
    const { RoutePublication } = await import('../src/components/route-publication');
    await page.render(createElement(RoutePublication, { route, dirty: false, revision: 0, participants: [person], onPublished }));
    const quantity = await prepare(page);
    await click(button(page.container, 'Review publication'));
    await waitFor(() => page.container.textContent?.includes('Awaiting customer confirmation') === true, 'review');
    const call = api.calls.find((entry) => entry.pathname.endsWith('/publication-review'));
    assert.ok(call);
    const body = publicationRequestSchema.parse(call.body);
    const stop = body.stops[0]; assert.ok(stop?.mode === 'create');
    assert.equal(stop.workLines[0]?.deliveryMilli, 500);
    assert.equal(stop.responsibleParticipantId, personId);
    assert.deepEqual(stop.templateIds, [templateId]);
    await toggle(checkbox(page.container, 'I reviewed the complete schedule'));
    assert.equal(button(page.container, 'Publish reviewed route').disabled, true);
    assert.match(page.container.textContent ?? '', /not enabled on this stand/);
    await page.render(createElement(RoutePublication, { route, dirty: false, revision: 1, participants: [person], onPublished }));
    await waitFor(() => api.calls.filter((entry) => entry.pathname === '/templates').length === 2, 'refresh');
    assert.equal(page.container.querySelector('[data-work-line="10"] input'), quantity);
    assert.equal(quantity.value, '0.5');
    assert.equal(checkbox(page.container, template.title).checked, true);
    assert.equal(checkbox(page.container, 'I reviewed the complete schedule').checked, false);
    assert.match(page.container.textContent ?? '', /review is out of date/);
    assert.equal(api.calls.some((entry) => entry.pathname.endsWith('/publish')), false);
    assert.deepEqual(published, []);
  } finally { await page.close(); }
});

void test('enabled Publish requires explicit acknowledgement and reuses its request ID after a lost response', async () => {
  const api = new ApiFixture(); api.templates = [template];
  api.defer('/routes/publication-capability').reply({ enabled: true, reason: null });
  api.defer(`/routes/${routeId}/publication-review`, 'POST').reply(review(true));
  api.defer(`/routes/${routeId}/publish`, 'POST').reply({ message: 'Temporary connection failure' }, 503);
  api.defer(`/routes/${routeId}/publish`, 'POST').reply(summary);
  const page = await domHarness(api);
  let completed = 0;
  const onPublished = () => { completed++; };
  try {
    const { RoutePublication } = await import('../src/components/route-publication');
    await page.render(createElement(RoutePublication, { route, dirty: false, revision: 0, participants: [person], onPublished }));
    await prepare(page);
    await click(button(page.container, 'Review publication'));
    await waitFor(() => page.container.textContent?.includes('Exact work to publish') === true, 'review');
    assert.equal(button(page.container, 'Publish reviewed route').disabled, true);
    await toggle(checkbox(page.container, 'I reviewed the complete schedule'));
    await click(button(page.container, 'Publish reviewed route'));
    await waitFor(() => page.container.textContent?.includes('Temporary connection failure') === true, 'retryable failure');
    await click(button(page.container, 'Publish reviewed route'));
    await waitFor(() => completed === 1, 'publication');
    const commands = api.calls.filter((entry) => entry.pathname.endsWith('/publish'));
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[0]?.body, commands[1]?.body, 'Lost responses must not generate a new publication request');
    assert.equal(hasToast(page.dom.window.document, 'Route published'), true);
    assert.match(page.container.textContent ?? '', /already been published/);
    assert.equal(Array.from(page.container.querySelectorAll('button')).some((entry) => entry.textContent === 'Publish reviewed route'), false);
  } finally { await page.close(); }
});

void test('unsaved changes prevent review and an existing publication is read back without new mutations', async () => {
  const api = new ApiFixture(); api.templates = [template];
  const page = await domHarness(api);
  let readBack = 0;
  const onPublished = () => { readBack++; };
  try {
    const { RoutePublication } = await import('../src/components/route-publication');
    await page.render(createElement(RoutePublication, { route, dirty: true, revision: 0, participants: [person], onPublished }));
    await prepare(page);
    assert.equal(button(page.container, 'Review publication').disabled, true);
    api.defer(`/routes/${routeId}/publication`).reply({ ...summary, review: review(true) });
    await page.render(createElement(RoutePublication, { route, dirty: true, revision: 1, participants: [person], onPublished }));
    await waitFor(() => readBack === 1, 'existing publication');
    assert.match(page.container.textContent ?? '', /already been published/);
    assert.match(page.container.textContent ?? '', /Customer confirmation at publication/);
    assert.match(page.container.textContent ?? '', /Deliver: 0.5 unit/);
    assert.equal(api.calls.some((entry) => entry.method !== 'GET'), false);
  } finally { await page.close(); }
});

void test('linking a confirmed booked visit preserves its work and responsible participant without offering editable replacement quantities', async () => {
  const api = new ApiFixture();
  api.detail.delivery.appointments.push(appointmentSchema.parse({ id: visitId, startsAt: at, endsAt: later, status: 'booked',
    cancellationReason: null, returnRequestId: null, assignments: [], results: [], workScope: scope,
    responsibleParticipant: { id: personId, name: person.name }, customerConfirmation: { confirmedAt: at, confirmedBy: { id: personId, name: 'DEMO operator' } } }));
  const linkedRoute = routeDraftSchema.parse({ ...route, stops: [{ deliveryId: detail.delivery.id, appointmentId: visitId, workMinutes: 30 }] });
  const linkedReview = review(false);
  const stop = linkedReview.stops[0]; assert.ok(stop);
  stop.mode = 'attach'; stop.customerConfirmationStatus = 'customer_confirmed';
  api.defer(`/routes/${routeId}/publication-review`, 'POST').reply(linkedReview);
  const page = await domHarness(api);
  const opened: string[] = [];
  try {
    const { RoutePublication } = await import('../src/components/route-publication');
    await page.render(createElement(RoutePublication, { route: linkedRoute, dirty: false, revision: 0, participants: [person], onPublished: () => undefined, onOpenDelivery: (id) => { opened.push(id); } }));
    await click(button(page.container, 'Prepare publication'));
    await waitFor(() => page.container.textContent?.includes('Customer confirmed') === true, 'linked booked visit');
    assert.equal(page.container.querySelector('[data-work-line] input'), null);
    assert.match(page.container.textContent ?? '', /Deliver: 0.5 unit/);
    await click(button(page.container, 'Open delivery details'));
    assert.deepEqual(opened, [detail.delivery.id]);
    await click(button(page.container, 'Review publication'));
    await waitFor(() => page.container.textContent?.includes('Exact work to publish') === true, 'linked review');
    const call = api.calls.find((entry) => entry.pathname.endsWith('/publication-review')); assert.ok(call);
    assert.deepEqual(publicationRequestSchema.parse(call.body).stops, [{ mode: 'attach', deliveryId: detail.delivery.id, appointmentId: visitId, responsibleParticipantId: personId }]);
  } finally { await page.close(); }
});

void test('a publication conflict requires a new review and explicit acknowledgement', async () => {
  const api = new ApiFixture(); api.templates = [template];
  api.defer('/routes/publication-capability').reply({ enabled: true, reason: null });
  api.defer(`/routes/${routeId}/publication-review`, 'POST').reply(review(true));
  api.defer(`/routes/${routeId}/publish`, 'POST').reply({ message: 'The reviewed data changed.' }, 409);
  const page = await domHarness(api);
  try {
    const { RoutePublication } = await import('../src/components/route-publication');
    await page.render(createElement(RoutePublication, { route, dirty: false, revision: 0, participants: [person], onPublished: () => undefined }));
    await prepare(page);
    await click(button(page.container, 'Review publication'));
    await waitFor(() => page.container.textContent?.includes('Exact work to publish') === true, 'review');
    await toggle(checkbox(page.container, 'I reviewed the complete schedule'));
    await click(button(page.container, 'Publish reviewed route'));
    await waitFor(() => page.container.textContent?.includes('The reviewed data changed.') === true, 'conflict');
    assert.equal(button(page.container, 'Publish reviewed route').disabled, true);
    assert.equal(checkbox(page.container, 'I reviewed the complete schedule').checked, false);
    assert.match(page.container.textContent ?? '', /review is out of date/);
    assert.equal(api.calls.filter((entry) => entry.pathname.endsWith('/publish')).length, 1);
  } finally { await page.close(); }
});

void test('review schema preserves separate source identities and rejects mismatched work-line snapshots', () => {
  const other = structuredClone(scope.lines[0]); assert.ok(other);
  other.sourceLineId = 20; other.sourceItem.sourceLineId = 20; other.sourceItem.saleOrderId = 2;
  const value = review(false);
  const stop = value.stops[0]; assert.ok(stop);
  stop.workScope.lines.push(other);
  const parsed = publicationReviewSchema.parse(value);
  assert.equal(parsed.stops[0]?.workScope.lines.length, 2);
  assert.deepEqual(parsed.stops[0]?.workScope.lines.map((line) => line.sourceLineId), [10, 20]);
  other.sourceItem.sourceLineId = 10;
  assert.equal(publicationReviewSchema.safeParse(value).success, false);
});
