import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { finishVisit } from '../src/_pages/visit-detail/api/commands';
import { finishErrorStep, readFinishWork } from '../src/_pages/visit-detail/model/finish-draft';
import { readFinishEvidence } from '../src/_pages/visit-detail/model/finish-evidence';
import type { SignaturePair } from '../src/_pages/visit-detail/model/signature';
import { VisitFinishResult } from '../src/_pages/visit-detail/ui/finish-result';
import { VisitActionBar } from '../src/_pages/visit-detail/ui/visit-detail-screen';
import type { VisitDetail } from '../src/shared/api/contracts';
import { renderLocalized } from './render-localized';

const responsibleParticipant = { id: 'b54e2ac4-807e-42e2-b5a8-600d16d90151', name: 'Marco Rossi' };
const visit: VisitDetail = {
  id: 'b54e2ac4-807e-42e2-b5a8-600d16d90152',
  pickingName: 'DEMO/CATANIA/PARTIAL',
  startsAt: '2026-11-17T13:00:00Z',
  endsAt: '2026-11-17T14:00:00Z',
  status: 'in_progress', confirmationStatus: 'customer_confirmed',
  destination: { address: 'Via Etnea 397', city: 'Catania', country: 'IT' },
  crews: [], vehicles: [], version: 7, responsibleParticipant, canFinish: true, canStart: false,
  scopeReviewReason: null,
  workScope: { revision: 1, confirmedAt: '2026-11-17T10:00:00Z', lines: [
    { sourceLineId: 31, deliveryMilli: 2000, installationMilli: 0, collectionMilli: 0, service: 'delivery_only' },
  ] },
  actualStartedAt: '2026-11-17T13:04:00Z', unfinishedChecklistCount: 0,
  customer: { name: 'Demo customer', contact: null, phones: [] },
  instructions: { floor: null, elevator: 'unknown', access: null, parking: null, restrictions: null, notes: null },
  items: [{ sourceLineId: 31, name: 'Oak cabinet', quantity: 2, remainingMilli: 2000, uom: 'unit', configuration: null, notes: null,
    orderName: 'DEMO/ORDER/31', serviceWork: { service: 'delivery_only', remainingDeliveryMilli: 2000, remainingInstallationMilli: 0,
      remainingCollectionMilli: 0, availableInstallationMilli: 0, plannedDeliveryMilli: 2000, plannedInstallationMilli: 0, plannedCollectionMilli: 0 },
  }], tasks: [],
};
const actions = { busy: null, run: async () => false };
const signatures: SignaturePair = {
  customer: [[{ x: 50, y: 10 }, { x: 150, y: 70 }]],
  crew: [[{ x: 80, y: 10 }, { x: 40, y: 25 }]],
};

void test('the report keeps all three steps and their fields mounted inside one form', () => {
  for (const locale of ['en', 'it', 'ru', 'uz'] as const) {
    const html = renderLocalized(createElement(VisitFinishResult, { visit, actions, reportOpen: true }), locale);
    const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g);
    assert.equal(forms?.length, 1, locale);
    const form = forms?.[0];
    assert.ok(form, locale);
    const panels = [...form.matchAll(/<[^<>]+ data-report-step="(work|photos|signatures)"[^<>]*>/g)];
    assert.deepEqual(panels.map((panel) => panel[1]), ['work', 'photos', 'signatures'], locale);
    for (const [tag, step] of panels) {
      assert.ok(tag && step);
      assert.equal(/\shidden(?:=""|(?=\s|>))/.test(tag), step !== 'work', `${locale} ${step} visibility`);
      assert.doesNotMatch(tag, /\sdisabled(?:=""|(?=\s|>))/, `${locale} panel remains enabled while hidden`);
    }
    const [workPanel, photosPanel, signaturesPanel] = panels;
    assert.ok(workPanel && photosPanel && signaturesPanel);
    assert.match(form.slice(workPanel.index, photosPanel.index), /name="quantity-31-delivery"/);
    assert.match(form.slice(photosPanel.index, signaturesPanel.index), /type="file"/);
    const signatureMarkup = form.slice(signaturesPanel.index);
    assert.match(signatureMarkup, /name="customerSignerName"/);
    assert.match(signatureMarkup, /data-signature-pad="customer"/);
    assert.match(signatureMarkup, /data-signature-pad="crew"/);
    assert.doesNotMatch(form, /MISSING_MESSAGE/);
  }
});

void test('the report is offered only for the responsible crew member when finishing is allowed', () => {
  const render = (detail: VisitDetail) => renderLocalized(createElement(VisitFinishResult, { visit: detail, actions, reportOpen: true }));
  for (const detail of [
    { ...visit, canFinish: false },
    { ...visit, canFinish: false, responsibleParticipant: null },
    { ...visit, canFinish: false, status: 'booked' },
    { ...visit, canFinish: true, scopeReviewReason: 'damage_hold' },
  ] satisfies VisitDetail[]) {
    assert.doesNotMatch(render(detail), /<form\b|data-report-step=|data-signature-pad=/);
  }
  const html = render({ ...visit, canFinish: false });
  assert.match(html, /Marco Rossi/);
});

void test('the visit action respects confirmation and finishing permissions', () => {
  const render = (detail: VisitDetail) => renderLocalized(createElement(VisitActionBar, { visit: detail, actions, onOpenReport: () => undefined }));
  const awaiting: VisitDetail = { ...visit, status: 'booked', canFinish: false, confirmationStatus: 'awaiting_customer_confirmation' };
  const pending = render(awaiting);
  assert.match(pending, /<button\b[^>]*\sdisabled=""[^>]*>/);
  assert.match(pending, /Wait for your dispatcher to record/);
  const available = render({ ...awaiting, canStart: true, confirmationStatus: 'customer_confirmed' });
  assert.match(available, /Start visit/);
  assert.doesNotMatch(available, /<button\b[^>]*\sdisabled=""[^>]*>/);
  const blocked = render({ ...visit, canFinish: false });
  assert.match(blocked, /Marco Rossi/);
  assert.match(blocked, /<button\b[^>]*\sdisabled=""[^>]*>/);
  const ready = render(visit);
  assert.match(ready, /Record visit result/);
  assert.doesNotMatch(ready, /<button\b[^>]*\sdisabled=""[^>]*>/);
  assert.equal(render({ ...visit, status: 'completed', canFinish: false }), '');
});

function partialFields() {
  const fields = new FormData();
  fields.set('summary', 'One of two cabinets delivered.');
  fields.set('quantity-31-delivery', '1');
  fields.set('incomplete-31-delivery-reason', 'missing_goods_or_parts');
  fields.set('incomplete-31-delivery-note', 'Second cabinet was missing.');
  fields.set('customerSignerName', 'Demo customer');
  return fields;
}

void test('blocking errors lead to the relevant report step', () => {
  const fields = partialFields();
  fields.delete('incomplete-31-delivery-reason');
  const incomplete = readFinishWork(visit, fields);
  assert.ok(!incomplete.ok);
  assert.equal(incomplete.error.field, 'incompleteWork');
  assert.equal(finishErrorStep(incomplete.error), 'work');

  const work = readFinishWork(visit, partialFields());
  assert.ok(work.ok);
  const missingPhoto = readFinishEvidence(fields, signatures, work.work.quantities, 0);
  assert.ok(!missingPhoto.ok);
  assert.equal(finishErrorStep(missingPhoto.error), 'photos');

  const missingSignature = readFinishEvidence(fields, { ...signatures, customer: [] }, work.work.quantities, 1);
  assert.ok(!missingSignature.ok);
  assert.equal(finishErrorStep(missingSignature.error), 'signatures');
});

void test('a partial report retains its exact line, photo and signatures for an explicit retry', async (t) => {
  const fields = partialFields();
  const draft = readFinishWork(visit, fields);
  assert.ok(draft.ok);
  assert.deepEqual(draft.work.quantities, [{ sourceLineId: 31, deliveredMilli: 1000 }]);
  assert.deepEqual(draft.work.incompleteWork, [{ sourceLineId: 31, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'Second cabinet was missing.' }]);
  const proof = readFinishEvidence(fields, signatures, draft.work.quantities, 1);
  assert.ok(proof.ok);
  const report = {
    ...draft.work, ...proof.evidence, photos: [{ sourceLineId: 31, name: 'cabinet.png', base64: 'eA==' }],
    version: visit.version, requestId: 'b54e2ac4-807e-42e2-b5a8-600d16d90153',
  };
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', (input: string, init: RequestInit) => {
    assert.equal(input, `/api/crew/visits/${visit.id}/finish`);
    assert.equal(init.method, 'POST');
    assert.equal(typeof init.body, 'string');
    if (typeof init.body !== 'string') throw new Error('Expected a serialized visit report');
    requests.push(init.body);
    if (requests.length === 1) return Promise.reject(new TypeError('Synthetic connection loss'));
    return Promise.resolve(Response.json({ ...visit, status: 'completed', canFinish: false, version: visit.version + 1 }));
  });
  assert.deepEqual(await finishVisit(visit.id, report), { ok: false, status: 0 });
  assert.deepEqual(requests, [JSON.stringify(report)], 'An uncertain result must not trigger an automatic retry');
  const saved = await finishVisit(visit.id, report);
  assert.ok(saved.ok);
  assert.equal(saved.data.status, 'completed');
  assert.deepEqual(requests, [JSON.stringify(report), JSON.stringify(report)]);
});
