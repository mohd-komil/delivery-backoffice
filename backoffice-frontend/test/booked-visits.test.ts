import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { appointmentSchema, transportAllocationSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, deliveryId, domHarness, user, waitFor } from './refresh-fixtures';

void test('Visits separates booked scheduling and in-progress responsibility while History retains signed results and transport', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const personId = '88000000-0000-4000-8000-000000000010';
  const completedId = '88000000-0000-4000-8000-000000000002';
  const activeVisitId = '88000000-0000-4000-8000-000000000003';
  const transport = transportAllocationSchema.parse({
    id: '88000000-0000-4000-8000-000000000020',
    vehicle: { id: '88000000-0000-4000-8000-000000000021', version: 1, ownership: 'company', name: 'DEMO recorded transport', plate: 'HISTORY-123', providerName: null, providerContact: null },
    driver: { kind: 'none' }, reserveFrom: '2026-11-10T07:00:00Z', reserveTo: '2026-11-10T11:00:00Z', status: 'cancelled',
    createdAt: '2026-11-01T08:00:00Z', createdBy: { id: user.id, name: user.name }, replacesAllocationId: null,
    retiredAt: '2026-11-02T08:00:00Z', retiredBy: { id: user.id, name: user.name }, retirementReason: 'DEMO preserved transport cancellation',
  });
  const activeTransport = transportAllocationSchema.parse({ ...transport, id: '88000000-0000-4000-8000-000000000050', vehicle: { ...transport.vehicle, id: '88000000-0000-4000-8000-000000000051', name: 'DEMO current vehicle', plate: 'ACTIVE-123' }, status: 'active', retiredAt: null, retiredBy: null, retirementReason: null });
  const replacedTransport = transportAllocationSchema.parse({ ...transport, id: '88000000-0000-4000-8000-000000000052', vehicle: { ...transport.vehicle, id: '88000000-0000-4000-8000-000000000053', name: 'DEMO replaced vehicle', plate: 'REPLACED-123' }, status: 'replaced', retirementReason: 'DEMO preserved replacement reason' });
  const cancelledTransport = transportAllocationSchema.parse({ ...transport, id: '88000000-0000-4000-8000-000000000054', vehicle: { ...transport.vehicle, id: '88000000-0000-4000-8000-000000000055', name: 'DEMO cancelled vehicle', plate: 'CANCELLED-123' }, retirementReason: 'DEMO preserved cancelled allocation reason' });
  const assignment = {
    id: '88000000-0000-4000-8000-000000000030', crewId: '88000000-0000-4000-8000-000000000031', crewName: 'DEMO historical crew',
    people: [{ id: personId, name: 'DEMO historical worker', external: false }],
    tasks: [{ id: '88000000-0000-4000-8000-000000000032', templateId: '88000000-0000-4000-8000-000000000033', title: 'DEMO recorded task', severity: 'low', order: 1,
      checklist: [{ id: '88000000-0000-4000-8000-000000000034', label: 'DEMO completed check', done: true, waiver: null }] }],
  };
  const completed = appointmentSchema.parse({
    id: completedId, startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T10:00:00Z', status: 'completed', cancellationReason: null,
    returnRequestId: null, assignments: [assignment], results: [{
      id: '88000000-0000-4000-8000-000000000040', appointmentId: completedId, receivedAt: '2026-11-10T10:05:00Z', actualStart: '2026-11-10T08:00:00Z', actualEnd: '2026-11-10T10:00:00Z',
      summary: 'DEMO preserved signed work result', supersedesResultId: null, correctionReason: null,
      actor: { kind: 'crew', id: assignment.crewId, name: assignment.crewName }, responsiblePersonId: personId,
      quantities: [{ sourceLineId: 10, deliveredMilli: 1000 }], evidence: [],
      customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO preserved customer signature', at: '2026-11-10T10:00:00Z' },
      crewSignature: { status: 'signed', signerName: 'DEMO worker', text: 'DEMO preserved crew signature', at: '2026-11-10T10:01:00Z' },
      sourceSnapshot: api.detail.delivery.source, instructionsSnapshot: api.detail.delivery.instructions, assignmentsSnapshot: [assignment],
    }],
  });
  const drawnVisitId = '88000000-0000-4000-8000-000000000005';
  const drawnResult = appointmentSchema.parse({
    ...completed, id: drawnVisitId, results: completed.results.map((result) => ({
      ...result, id: '88000000-0000-4000-8000-000000000041', appointmentId: drawnVisitId,
      source: 'crew_frontoffice', summary: 'DEMO report with two drawings',
      customerSignature: { status: 'signed', capture: 'drawn', signerName: 'DEMO signing customer', at: result.actualEnd,
        strokes: [[{ x: 100, y: 600 }, { x: 500, y: 200 }]] },
      crewSignature: { status: 'signed', capture: 'drawn', signerName: 'DEMO responsible participant', at: result.actualEnd,
        strokes: [[{ x: 200, y: 200 }, { x: 900, y: 700 }], [{ x: 500, y: 500 }]] },
    })),
  });
  api.detail.delivery.appointments = [
    appointmentSchema.parse({ ...completed, id: '88000000-0000-4000-8000-000000000001', status: 'cancelled', cancellationReason: 'DEMO cancelled appointment', assignments: [], results: [], transportAllocations: [transport] }),
    completed,
    appointmentSchema.parse({ ...completed, id: activeVisitId, status: 'in_progress', results: [] }),
    appointmentSchema.parse({ ...completed, id: '88000000-0000-4000-8000-000000000004', status: 'booked', results: [], transportAllocations: [activeTransport, replacedTransport, cancelledTransport] }),
    drawnResult,
  ];
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.panel-meta') !== null, 'delivery detail');
    await click(button(document, 'Visits & tasks'));
    const cards = document.querySelectorAll('.visit-card');
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.querySelector('h3')?.textContent, 'Visit 4');
    assert.match(cards[0]?.querySelector('.badge')?.textContent ?? '', /^booked$/);
    const heading = Array.from(document.querySelectorAll('h3')).find((entry) => entry.textContent === 'Visits & crew assignments');
    assert.ok(heading); assert.match(heading.parentElement?.textContent ?? '', /1 booked/);
    assert.doesNotMatch(document.querySelector('.panel-body')?.textContent ?? '', /DEMO preserved signed work result|DEMO preserved customer signature|HISTORY-123/);
    const workingTransport = cards[0]?.querySelector('[data-visit-transport]'); assert.ok(workingTransport);
    assert.match(workingTransport.textContent ?? '', /DEMO current vehicle.*ACTIVE-123/s);
    assert.doesNotMatch(workingTransport.textContent ?? '', /REPLACED-123|CANCELLED-123|DEMO replaced vehicle|DEMO cancelled vehicle|DEMO preserved replacement reason|DEMO preserved cancelled allocation reason/);

    const sameData = api.defer(`/deliveries/${deliveryId}`); await click(button(document, '↻ Refresh'));
    await act(async () => { sameData.reply(api.detail); }); await waitFor(() => !button(document, '↻ Refresh').disabled, 'same-data refresh');
    assert.strictEqual(document.querySelector('[data-visit-transport]'), workingTransport, 'Refresh retains the working transport region');
    assert.match(workingTransport.textContent ?? '', /ACTIVE-123/);
    assert.doesNotMatch(workingTransport.textContent ?? '', /REPLACED-123|CANCELLED-123|DEMO preserved replacement reason|DEMO preserved cancelled allocation reason/);

    const refresh = api.defer(`/deliveries/${deliveryId}`);
    const previousCard = cards[0]; await click(button(document, '↻ Refresh'));
    assert.strictEqual(document.querySelector('.visit-card'), previousCard, 'Background refresh retains the existing booked card');
    api.detail.delivery.version = 2;
    api.detail.delivery.appointments = api.detail.delivery.appointments.map((visit) => visit.status === 'booked' ? { ...visit, status: 'cancelled', cancellationReason: 'DEMO last booking cancelled' } : visit);
    await act(async () => { refresh.reply(api.detail); });
    await waitFor(() => document.querySelectorAll('.visit-card').length === 0, 'no booked appointments');
    assert.match(heading.parentElement?.textContent ?? '', /0 booked/);
    assert.match(document.querySelector('.empty')?.textContent ?? '', /no booked/i);
    assert.ok(button(document, 'Book appointment'), 'The booking form remains available');

    await click(button(document, 'History'));
    const body = document.querySelector('.panel-body'); assert.ok(body);
    assert.match(body.textContent ?? '', /Recorded visits/);
    assert.match(body.textContent ?? '', /Visit 1.*cancelled/s);
    assert.match(body.textContent ?? '', /Visit 2.*completed/s);
    assert.match(body.textContent ?? '', /DEMO preserved signed work result/);
    assert.match(body.textContent ?? '', /DEMO preserved customer signature/);
    assert.match(body.textContent ?? '', /DEMO preserved crew signature/);
    const customerDrawing = body.querySelector('svg[aria-label="Handwritten signature of DEMO signing customer"]');
    const crewDrawing = body.querySelector('svg[aria-label="Handwritten signature of DEMO responsible participant"]');
    assert.equal(customerDrawing?.querySelector('polyline')?.getAttribute('points'), '100,600 500,200');
    assert.equal(crewDrawing?.querySelector('polyline')?.getAttribute('points'), '200,200 900,700');
    assert.equal(crewDrawing?.querySelector('circle')?.getAttribute('cx'), '500');
    assert.match(body.textContent ?? '', /DEMO recorded transport.*HISTORY-123/s);
    assert.match(body.textContent ?? '', /DEMO preserved transport cancellation/);
    assert.match(body.textContent ?? '', /ACTIVE-123/);
    assert.match(body.textContent ?? '', /REPLACED-123/);
    assert.match(body.textContent ?? '', /CANCELLED-123/);
    assert.match(body.textContent ?? '', /DEMO preserved replacement reason/);
    assert.match(body.textContent ?? '', /DEMO preserved cancelled allocation reason/);
    assert.equal(body.querySelector('.visit-editor'), null, 'Recorded visits are read-only');
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false, 'Filtering and History navigation never mutate data');

    await click(button(document, 'Visits & tasks'));
    const activeSection = document.querySelector('section[aria-label="Visit work in progress"]');
    assert.ok(activeSection);
    assert.match(activeSection.textContent ?? '', /Visit 3/);
    assert.equal(activeSection.querySelector('select[name="participantId"]')?.getAttribute('required'), '');
    assert.equal(activeSection.querySelector('option:checked')?.getAttribute('value'), personId);
    const path = `/deliveries/${deliveryId}/appointments/${activeVisitId}/responsible`;
    const assignmentRequest = api.defer(path, 'PATCH');
    await click(button(activeSection, 'Save responsible participant'));
    assert.equal(assignmentRequest.called, true);
    assert.deepEqual(api.calls.find((call) => call.pathname === path && call.method === 'PATCH')?.body, { version: 2, participantId: personId });
    api.detail.delivery.version = 3;
    api.detail.delivery.appointments = api.detail.delivery.appointments.map((visit) => visit.id === activeVisitId
      ? { ...visit, responsibleParticipant: { id: personId, name: 'DEMO historical worker' } }
      : visit);
    await act(async () => { assignmentRequest.reply(api.detail); });
    await waitFor(() => activeSection.textContent?.includes('Responsible participant: DEMO historical worker') === true, 'saved responsible participant');
  } finally { await page.close(); }
});
