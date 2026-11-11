import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { appointmentSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, user, waitFor } from './refresh-fixtures';

void test('failed visit shows the crew reason in History and leaves scheduling available in Inbox', async () => {
  const api = new ApiFixture();
  const reason = 'No answer at the door. Note left at entrance. <b>DEMO</b>';
  const at = '2026-11-06T09:30:00Z';
  const actor = { id: '89000000-0000-4000-8000-000000000002', name: 'DEMO crew participant' };
  const visit = appointmentSchema.parse({
    id: '89000000-0000-4000-8000-000000000001', startsAt: '2026-11-06T09:00:00Z', endsAt: '2026-11-06T10:00:00Z',
    status: 'failed', cancellationReason: null, returnRequestId: null, assignments: [], results: [],
    failedAttempt: { reason, at, actor },
  });
  api.detail.delivery.appointments = [visit];
  api.detail.history = [{ id: '89000000-0000-4000-8000-000000000003', actorId: actor.id, actorName: actor.name, at, action: 'execution.customer_absent', details: { appointmentId: visit.id, reason } }];
  api.list.items = [api.detail.delivery];

  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table tbody tr') !== null, 'Inbox delivery');
    await click(button(document, 'DEMO/OUT/REFRESH'));
    await waitFor(() => document.querySelector('.detail-tab-overview') !== null, 'delivery details');
    await click(button(document, 'History'));

    const history = document.querySelector('.detail-tab-history');
    assert.equal(history?.querySelector('.history-list h4')?.textContent, 'Customer absent');
    const recordedVisit = history?.querySelector('article');
    assert.ok(recordedVisit);
    assert.match(recordedVisit.textContent ?? '', /Customer absent.*DEMO crew participant/s);
    assert.equal(recordedVisit.querySelector('dd')?.textContent, reason);
    assert.equal(recordedVisit.querySelector('dd b'), null, 'Stored crew text must be rendered as text');
    assert.equal(recordedVisit.querySelector('time')?.dateTime, at);

    await click(button(document, 'Visits & tasks'));
    const visits = document.querySelector('.detail-tab-visits');
    assert.match(visits?.textContent ?? '', /No booked visits/);
    assert.match(visits?.textContent ?? '', /Book a new appointment/);
  } finally {
    await page.close();
  }
});

void test('History keeps condition, notes and photos under their recorded order line', async () => {
  const api = new ApiFixture();
  const delivery = api.detail.delivery;
  const product = delivery.source.items[0];
  assert.ok(product);
  const snapshot = {
    ...delivery.source,
    salesOrders: [{ id: 1, name: 'DEMO/SO/A' }, { id: 2, name: 'DEMO/SO/B' }],
    items: [{ ...product, saleOrderId: 1 }, { ...product, saleOrderId: 2, sourceLineId: 20 }],
  };
  const visitId = '89000000-0000-4000-8000-000000000010';
  const oldVisitId = '89000000-0000-4000-8000-000000000011';
  const productPhoto = '89000000-0000-4000-8000-000000000013';
  const generalPhoto = '89000000-0000-4000-8000-000000000014';
  const oldPhoto = '89000000-0000-4000-8000-000000000015';
  const actor = { kind: 'crew', id: '89000000-0000-4000-8000-000000000016', name: 'DEMO crew participant' };
  const note = 'Corner chipped.\n<b>Do not interpret as markup.</b>';
  const actualStart = '2026-11-06T09:00:00Z';
  const actualEnd = '2026-11-06T10:00:00Z';
  const result = {
    id: '89000000-0000-4000-8000-000000000017', appointmentId: visitId,
    receivedAt: actualEnd, actualStart, actualEnd, summary: 'DEMO product checks result',
    supersedesResultId: null, correctionReason: null, actor, responsiblePersonId: actor.id,
    quantities: [], customerSignature: null, crewSignature: null,
    sourceSnapshot: snapshot, instructionsSnapshot: delivery.instructions, assignmentsSnapshot: [],
  };
  const visit = { id: visitId, startsAt: actualStart, endsAt: actualEnd, status: 'completed', cancellationReason: null, returnRequestId: null, assignments: [] };
  const saved = appointmentSchema.parse({ ...visit, results: [{ ...result,
    itemChecks: [{ sourceLineId: 10, status: 'ok', note: null }, { sourceLineId: 20, status: 'problem', note }],
    evidence: [{ id: productPhoto, type: 'photo', itemIds: [20] }, { id: generalPhoto, type: 'photo', itemIds: [] }],
  }] });
  const old = appointmentSchema.parse({ ...visit, id: oldVisitId, results: [{ ...result,
    id: '89000000-0000-4000-8000-000000000018', appointmentId: oldVisitId, summary: 'DEMO older result',
    evidence: [{ id: oldPhoto, type: 'photo', itemIds: [] }],
  }] });
  const [recorded] = saved.results;
  const [legacy] = old.results;
  assert.ok(recorded && legacy);
  const { groupResultPhotos } = await import('../src/components/delivery-result-evidence');
  const { photosByLine, generalPhotos } = groupResultPhotos(recorded);
  assert.equal(photosByLine.has(10), false);
  assert.deepEqual(photosByLine.get(20)?.map(({ id }) => id), [productPhoto]);
  assert.deepEqual(generalPhotos.map(({ id }) => id), [generalPhoto]);
  assert.deepEqual(groupResultPhotos(legacy).generalPhotos.map(({ id }) => id), [oldPhoto]);
  // The browser exercises the authenticated Next image renderer. Direct Node/JSDOM
  // uses its CommonJS namespace instead of Next's bundled component.
  delivery.appointments = [
    { ...saved, results: [{ ...recorded, evidence: [] }] },
    { ...old, results: [{ ...legacy, evidence: [] }] },
  ];
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: delivery.id, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.detail-tab-overview') !== null, 'delivery details');
    await click(button(document, 'History'));
    const [newCard, oldCard] = document.querySelectorAll('.result-card');
    assert.ok(newCard && oldCard);
    const checks = newCard.querySelector('section[aria-label="Product checks"]');
    const [firstLine, secondLine] = checks?.querySelectorAll(':scope > ul > li') ?? [];
    assert.ok(firstLine && secondLine);
    assert.match(firstLine.textContent ?? '', /DEMO table · DEMO\/SO\/A · line 10.*Everything is OK/s);
    assert.match(secondLine.textContent ?? '', /DEMO table · DEMO\/SO\/B · line 20.*Problem noted/s);
    assert.equal(secondLine.querySelector('p')?.textContent, note);
    assert.equal(secondLine.querySelector('b'), null);
    assert.equal(oldCard.querySelector('section[aria-label="Product checks"]'), null);

    api.detail.delivery = { ...delivery, version: 2, source: { ...delivery.source, items: [{ ...product, name: 'DEMO renamed later' }] } };
    await click(button(document, '↻ Refresh'));
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'new delivery version');
    assert.strictEqual(document.querySelector('section[aria-label="Product checks"]'), checks);
    assert.match(checks?.textContent ?? '', /DEMO table · DEMO\/SO\/B · line 20/);
    assert.doesNotMatch(checks?.textContent ?? '', /renamed later/);
  } finally {
    await page.close();
  }
});
