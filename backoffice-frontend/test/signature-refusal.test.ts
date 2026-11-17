import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { appointmentSchema, signatureRefusalReviewCommandSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, editInput, hasToast, user, waitFor } from './refresh-fixtures';

const appointmentId = '99000000-0000-4000-8000-000000000001';
const resultId = '99000000-0000-4000-8000-000000000002';
const finishedAt = '2026-11-16T10:00:00Z';

function installReport(api: ApiFixture) {
  const delivery = api.detail.delivery;
  const item = delivery.source.items[0];
  assert.ok(item);
  const source = { ...delivery.source, saleOrderName: 'ORDER ONE',
    salesOrders: [{ id: 1, name: 'ORDER ONE' }, { id: 2, name: 'ORDER TWO' }],
    items: [{ ...item, saleOrderId: 1, quantity: 2 }, { ...item, saleOrderId: 2, sourceLineId: 20 }] };
  delivery.source = source;
  delivery.appointments = [appointmentSchema.parse({
    id: appointmentId, startsAt: '2026-11-16T09:00:00Z', endsAt: finishedAt, status: 'completed',
    returnRequestId: null, cancellationReason: null, assignments: [], results: [{
      id: resultId, appointmentId, receivedAt: finishedAt, actualStart: '2026-11-16T09:00:00Z', actualEnd: finishedAt,
      source: 'crew_frontoffice', summary: 'Both order lines were reported.', supersedesResultId: null, correctionReason: null,
      actor: { kind: 'crew', id: user.id, name: 'DEMO participant' }, responsiblePersonId: user.id,
      quantities: [{ sourceLineId: 10, deliveredMilli: 2000 }, { sourceLineId: 20, deliveredMilli: 1000 }],
      evidence: [], customerSignature: null, crewSignature: { status: 'signed', signerName: 'DEMO participant', text: 'DEMO signed report', at: finishedAt },
      signatureRefusal: { reason: 'Customer declined after the handover.', noPhotoReason: 'Customer prohibited indoor photos.' },
      sourceSnapshot: source, instructionsSnapshot: delivery.instructions, assignmentsSnapshot: [],
    }],
  })];
  api.detail.closureBlockers = [`Visit ${appointmentId} requires review of the customer's refusal to sign`];
}

void test('the exact unsigned report opens from History and a review corrects only the intended order line', async () => {
  const api = new ApiFixture();
  installReport(api);
  const appointment = api.detail.delivery.appointments[0];
  assert.ok(appointment);
  const original = structuredClone(appointment.results[0]);
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: api.detail.delivery.id, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.detail-tab-overview') !== null, 'delivery details');
    assert.equal(button(document, 'Verify & complete delivery').disabled, true);
    await click(button(document, 'Review in History'));
    const report = document.getElementById(`result-${resultId}`);
    assert.ok(report);
    assert.match(report.textContent ?? '', /Pending dispatcher review/);
    assert.match(report.textContent ?? '', /Customer declined after the handover/);
    assert.match(report.textContent ?? '', /prohibited indoor photos/);
    assert.match(report.textContent ?? '', /DEMO signed report/);

    await click(button(report, 'Review signature refusal'));
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((element) => element.querySelector('textarea[name="reason"]'));
    assert.ok(dialog);
    await click(button(dialog, 'Save review'));
    assert.equal(api.calls.some(({ method }) => method === 'POST'), false);

    const corrected = dialog.querySelector('input[name="decision"][value="corrected"]');
    assert.ok(corrected instanceof HTMLInputElement);
    await act(async () => { corrected.click(); });
    const amount = dialog.querySelector('input[name="correction-10-deliveredMilli"]');
    const reason = dialog.querySelector('textarea[name="reason"]');
    assert.ok(amount instanceof HTMLInputElement && reason instanceof HTMLTextAreaElement);
    await editInput(amount, '1.5');
    reason.value = 'Francesca verified one and a half units on order one.';
    const endpoint = `/deliveries/${api.detail.delivery.id}/appointments/${appointmentId}/results/${resultId}/signature-refusal-review`;
    const failure = api.defer(endpoint, 'POST');
    await click(button(dialog, 'Save review'));
    const command = signatureRefusalReviewCommandSchema.parse(api.calls.find(({ pathname }) => pathname === endpoint)?.body);
    assert.equal(command.decision, 'corrected');
    assert.deepEqual(command.quantities, [{ sourceLineId: 10, deliveredMilli: 1500 }, { sourceLineId: 20, deliveredMilli: 1000 }]);
    await act(async () => failure.reply({ message: 'Temporary service failure' }, 503));
    await waitFor(() => !button(dialog, 'Save review').disabled, 'review retry');

    const success = api.defer(endpoint, 'POST');
    await click(button(dialog, 'Save review'));
    assert.deepEqual(api.calls.filter(({ pathname }) => pathname === endpoint).at(-1)?.body, command);
    api.detail.delivery.version++;
    appointment.signatureRefusalReview = {
      resultId, decision: 'corrected', reason: command.reason, quantities: command.quantities,
      reviewedBy: { id: user.id, name: 'Francesca' }, reviewedAt: '2026-11-16T12:00:00Z',
    };
    api.detail.closureBlockers = ['Remaining quantity: DEMO table (0.5 unit)'];
    await act(async () => success.reply(api.detail, 201));
    await waitFor(() => hasToast(document, 'Signature refusal review saved'), 'review saved');
    assert.match(report.textContent ?? '', /Quantities corrected/);
    assert.match(report.textContent ?? '', /ORDER ONE.*2 → 1.5/s);
    assert.match(report.textContent ?? '', /Francesca verified/);
    assert.doesNotMatch(report.textContent ?? '', /Pending dispatcher review/);
    assert.equal(button(document, 'Verify & complete delivery').disabled, true, 'remaining work still blocks closure');
    assert.deepEqual(appointment.results[0], original);
  } finally { await page.close(); }
});
