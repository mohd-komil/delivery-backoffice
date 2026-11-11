import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentSignatures, extendSignatureStroke, isSignerName, signatureDraftScope, signatureHasInk,
  signatureInputFingerprint, signaturePoint, startSignatureStroke, type SignaturePair, type SignatureStrokes,
} from '../src/_pages/visit-detail/model/signature';

void test('signature pad records bounded normalized ink and rejects taps', () => {
  const surface = { left: 10, top: 20, width: 200, height: 100 };
  assert.deepEqual(signaturePoint(110, 70, surface), { x: 500, y: 500 });
  assert.deepEqual(signaturePoint(-2, 122, surface), { x: 0, y: 1000 });
  assert.equal(signaturePoint(110, 70, { ...surface, width: 0 }), null);

  let strokes: SignatureStrokes = startSignatureStroke([], { x: 0, y: 0 });
  assert.equal(signatureHasInk(strokes), false);
  assert.equal(signatureHasInk(extendSignatureStroke(strokes, { x: 7, y: 7 })), false);
  for (let x = 1; x <= 1000; x += 1) strokes = extendSignatureStroke(strokes, { x, y: x % 17 });
  assert.equal(signatureHasInk(strokes), true);
  assert.ok((strokes[0]?.length ?? 0) <= 256);
  assert.deepEqual(strokes[0]?.[0], { x: 0, y: 0 });
  assert.deepEqual(strokes[0]?.at(-1), { x: 1000, y: 14 });
});

void test('signature draft accepts an unchanged scope and rejects changed data or responsible person', () => {
  const pair: SignaturePair = { customer: [[{ x: 0, y: 0 }, { x: 10, y: 10 }]], crew: [[{ x: 20, y: 0 }, { x: 30, y: 10 }]] };
  const scope = signatureDraftScope(2, 'person-a', 1);
  const draft = { scope, pair };
  assert.equal(currentSignatures(draft, scope), pair);
  for (const changed of [signatureDraftScope(3, 'person-a', 1), signatureDraftScope(2, 'person-b', 1), signatureDraftScope(2, 'person-a', 2)]) {
    assert.deepEqual(currentSignatures(draft, changed), { customer: [], crew: [] });
  }

  const fields = new FormData();
  fields.set('summary', 'Approved work');
  fields.set('quantity-1', '1');
  const accepted = signatureInputFingerprint(fields);
  assert.equal(signatureInputFingerprint(fields), accepted);
  fields.set('quantity-1', '2');
  assert.notEqual(signatureInputFingerprint(fields), accepted);
  assert.equal(isSignerName('Maria D’Angelo'), true);
  assert.equal(isSignerName('Maria\u0007'), false);
});
