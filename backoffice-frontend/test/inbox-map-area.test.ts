import assert from 'node:assert/strict';
import test from 'node:test';
import { appendInboxMapArea, inboxMapAreaSchema, inboxMapViewportKey, normalizeInboxMapArea } from '../src/lib/inbox-map-area';
import { inboxMapSchema } from '../src/lib/inbox-map';

const catania = { north: 37.55, south: 37.45, west: 15.02, east: 15.15 };

void test('visible-area bounds stay finite and non-wrapping, including the world seam and repeated Leaflet worlds', () => {
  assert.deepEqual(normalizeInboxMapArea(catania), catania);
  assert.deepEqual(normalizeInboxMapArea({ north: 110, south: -110, west: -200, east: 200 }), { north: 90, south: -90, west: -180, east: 180 });
  assert.deepEqual(normalizeInboxMapArea({ north: 40, south: 30, west: 530, east: 550 }), { north: 40, south: 30, west: -180, east: 180 });
  assert.deepEqual(normalizeInboxMapArea({ north: 40, south: 30, west: 190, east: 200 }), { north: 40, south: 30, west: -170, east: -160 });
  assert.deepEqual(normalizeInboxMapArea({ north: 40, south: 30, west: 170, east: -170 }), { north: 40, south: 30, west: -180, east: 180 });
  assert.deepEqual(normalizeInboxMapArea({ north: 40, south: 30, west: 170, east: 180 }), { north: 40, south: 30, west: 170, east: 180 });
  assert.equal(normalizeInboxMapArea({ ...catania, north: Number.NaN }), null);
  assert.equal(normalizeInboxMapArea({ ...catania, east: Infinity }), null);
  assert.equal(normalizeInboxMapArea({ ...catania, north: catania.south }), null);
  assert.equal(normalizeInboxMapArea({ ...catania, north: 10, south: 20 }), null);
  assert.equal(normalizeInboxMapArea({ north: 1e-10, south: 0, west: 0, east: 1 }), null, 'rounding must never produce a zero-height area');
  for (const bounds of [{ north: 40 }, { ...catania, east: catania.west }, { ...catania, west: 181 }, { ...catania, north: 91 }]) {
    assert.equal(inboxMapAreaSchema.safeParse(bounds).success, false);
  }
});

void test('area query applies equally to Map and List and clearing preserves other filters', () => {
  const query = new URLSearchParams('city=Catania&postalCode=95121&north=0&north=1');
  appendInboxMapArea(query, catania);
  assert.equal(query.toString(), 'city=Catania&postalCode=95121&north=37.55&south=37.45&east=15.15&west=15.02');
  assert.equal(query.getAll('north').length, 1);
  assert.equal(inboxMapViewportKey(query.toString()), 'city=Catania&postalCode=95121');
  appendInboxMapArea(query, { ...catania, north: 38 });
  assert.equal(query.get('north'), '38');
  appendInboxMapArea(query, null);
  assert.equal(query.toString(), 'city=Catania&postalCode=95121');
  const equator = normalizeInboxMapArea({ north: 0.0000001, south: -0.0000002, east: 0.0000003, west: -0.0000004 });
  assert.ok(equator);
  appendInboxMapArea(query, equator);
  assert.equal(query.get('north'), '0.0000001');
  assert.equal(query.get('west'), '-0.0000004');
  for (const value of ['north', 'south', 'east', 'west'].map((key) => query.get(key) ?? '')) assert.match(value, /^-?\d+(?:\.\d{1,8})?$/);
});

void test('map response validates area bounds and excluded coordinates independently of returned counts', () => {
  const data = { total: 0, mappedCount: 0, missingCount: 0, markers: [], missingCoordinates: [] };
  const response = inboxMapSchema.parse({ ...data, area: { bounds: catania, excludedMissingCoordinates: 3 } });
  assert.equal(response.area?.excludedMissingCoordinates, 3);
  assert.equal(response.total, 0);
  assert.equal(inboxMapSchema.parse(data).area, null);
  assert.equal(inboxMapSchema.safeParse({ ...data, area: { bounds: { ...catania, east: -200 }, excludedMissingCoordinates: 0 } }).success, false);
  assert.equal(inboxMapSchema.safeParse({ ...data, area: { bounds: catania, excludedMissingCoordinates: -1 } }).success, false);
});
