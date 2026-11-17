import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { apiDocument } from '../src/openapi';

const objectSchema = z.object({
  type: z.literal('object'), properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(), additionalProperties: z.boolean().optional(),
});
const operationSchema = z.object({
  description: z.string(), security: z.array(z.record(z.string(), z.array(z.string()))),
  parameters: z.array(z.object({ name: z.string(), in: z.string(), required: z.boolean(),
    schema: z.object({ type: z.string(), minimum: z.number().optional(), format: z.string().optional() }) })),
  requestBody: z.object({ content: z.object({ 'application/json': z.object({ schema: objectSchema }) }) }).optional(),
  responses: z.record(z.string(), z.object({ description: z.string(), content: z.object({ 'application/json': z.object({ schema: z.unknown() }) }).optional() })),
});

void test('OpenAPI exposes route lifecycle endpoints with exact session boundaries and HTTP 200 responses', () => {
  const document = apiDocument();
  const expected = [
    ['get', '/routes/reconciliation-owners'], ['get', '/routes/{id}/operations'], ['get', '/routes/{id}/timing'], ['get', '/routes/{id}/revisions/{version}'],
    ['post', '/routes/{id}/depart'], ['post', '/routes/{id}/amend-review'], ['post', '/routes/{id}/amend'],
    ['post', '/routes/{id}/cancel'], ['post', '/routes/{id}/abort'], ['post', '/routes/{id}/stops/{appointmentId}/skip'],
    ['post', '/routes/{id}/returning'], ['post', '/routes/{id}/return'], ['post', '/routes/{id}/reconcile'],
    ['post', '/routes/{id}/warehouse-receipts'], ['post', '/routes/{id}/close'],
    ['get', '/crew/routes'], ['get', '/crew/routes/{id}'], ['post', '/crew/routes/{id}/depart'],
    ['post', '/crew/routes/{id}/returning'], ['post', '/crew/routes/{id}/return'],
  ] as const;
  for (const [method, path] of expected) {
    const operation = operationSchema.parse(document.paths[path]?.[method]);
    assert.deepEqual(operation.security, path.startsWith('/crew/') ? [{ crewSession: [] }] : [{ session: [] }]);
    assert.ok(operation.responses['200'], path);
    assert.equal(operation.responses['201'], undefined, path);
    assert.ok(operation.responses['409'], path);
    assert.ok(operation.description.length > 30, path);
  }
  for (const forbidden of ['cancel', 'amend', 'abort', 'reconcile', 'warehouse-receipts', 'close', 'timing']) {
    assert.equal(document.paths[`/crew/routes/{id}/${forbidden}`], undefined);
  }
  const revision = operationSchema.parse(document.paths['/routes/{id}/revisions/{version}']?.['get']);
  assert.deepEqual(revision.parameters.find(({ name }) => name === 'version')?.schema, { type: 'integer', minimum: 1 });
  const timing = operationSchema.parse(document.paths['/routes/{id}/timing']?.get);
  const timingOutput = objectSchema.parse(timing.responses['200']?.content?.['application/json'].schema);
  assert.deepEqual(timingOutput.required, ['id', 'status', 'plan', 'route', 'stops']);
});

void test('OpenAPI represents actual return, cancellation confirmations and live exact-line output without transform fallbacks', () => {
  const document = apiDocument();
  const returned = operationSchema.parse(document.paths['/crew/routes/{id}/return']?.['post']);
  const returnInput = returned.requestBody?.content['application/json'].schema;
  assert.ok(returnInput);
  assert.deepEqual(returnInput.required, ['version', 'requestId', 'actualReturnedAt']);
  assert.equal(returnInput.additionalProperties, false);
  assert.match(returned.description, /warehouse acceptance are separate/);
  assert.match(returned.description, /original request ID, version and timestamp/);
  const depart = operationSchema.parse(document.paths['/routes/{id}/depart']?.['post']);
  assert.ok(depart.requestBody?.content['application/json'].schema.required?.includes('reason'));
  const cancellation = operationSchema.parse(document.paths['/routes/{id}/cancel']?.['post']);
  const cancelInput = cancellation.requestBody?.content['application/json'].schema;
  assert.ok(cancelInput);
  assert.equal(z.object({ const: z.literal(true) }).parse(cancelInput.properties['confirmNotDeparted']).const, true);
  assert.equal(z.object({ const: z.literal(true) }).parse(cancelInput.properties['confirmNotLoaded']).const, true);
  const operations = operationSchema.parse(document.paths['/routes/{id}/operations']?.['get']);
  const output = objectSchema.parse(operations.responses['200']?.content?.['application/json'].schema);
  const line = z.object({ type: z.literal('array'), items: objectSchema }).parse(output.properties['lines']).items;
  for (const key of ['appointmentId', 'sourceLineId', 'remainingDeliveryMilli', 'availableDeliveryMilli', 'warehouseReceivedCollectionMilli', 'declaration', 'packagingStatus']) {
    assert.ok(line.required?.includes(key), key);
  }
  const runtime = objectSchema.parse(output.properties['runtime']);
  assert.ok(runtime.required?.includes('returned'));
  assert.ok(runtime.required?.includes('warehouseReceipts'));
  const capabilities = objectSchema.parse(output.properties['capabilities']);
  for (const key of ['departBlockerCode', 'returnBlockerCode', 'canMarkReturned', 'closureIssues']) assert.ok(capabilities.required?.includes(key), key);
});
