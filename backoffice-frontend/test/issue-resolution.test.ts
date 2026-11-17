import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { DeliveryDetail } from '../src/lib/contracts';
import { ApiFixture, button, click, deliveryId, detailFixture, domHarness, editInput, user, waitFor } from './refresh-fixtures';

const issueId = '50000000-0000-4000-8000-000000000054';
const resolution = 'Site access checked and cleared.';

void test('resolving the last issue updates the open drawer and lets the operator complete the delivery at the saved version', async () => {
  const api = new ApiFixture();
  const issue: DeliveryDetail['delivery']['issues'][number] = {
    id: issueId, type: 'access', description: 'Access to the building was blocked.', itemIds: [], photoIds: [], notes: null,
    status: 'open', createdAt: '2026-11-16T10:00:00Z', authorId: user.id, authorName: user.name, source: 'operator',
    resolution: null, resolvedAt: null, resolvedBy: null,
  };
  api.detail = detailFixture(1);
  api.detail.delivery.issues = [issue];
  api.detail.views = ['issues'];
  api.detail.closureBlockers = ['Open issues remain'];
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, initialTab: 'issues', onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector(`#issue-${issueId}`) !== null, 'open issue');
    const panel = document.querySelector('.delivery-panel');
    const issueCard = panel?.querySelector(`#issue-${issueId}`);
    const completion = panel?.querySelector('.close-section');
    const note = issueCard?.querySelector('textarea[name="resolution"]');
    const notesEditor = issueCard?.querySelector('details');
    const notesDraft = notesEditor?.querySelector('textarea[name="notes"]');
    const registrationEditor = Array.from(panel?.querySelectorAll('details') ?? [])
      .find((element) => element.querySelector('summary')?.textContent?.trim() === 'Register an issue as operator');
    assert.ok(panel && issueCard && completion);
    assert.ok(note instanceof HTMLTextAreaElement);
    assert.ok(notesEditor instanceof page.dom.window.HTMLDetailsElement);
    assert.ok(notesDraft instanceof HTMLTextAreaElement);
    assert.ok(registrationEditor);
    assert.match(completion.textContent ?? '', /Open issues remain/u);
    assert.equal(button(completion, 'Verify & complete delivery').disabled, true);

    notesEditor.open = true;
    await editInput(notesDraft, 'Separate unsaved issue note.');
    await editInput(note, resolution);
    const resolvePath = `/deliveries/${deliveryId}/issues/${issueId}/resolve`;
    const pendingResolution = api.defer(resolvePath, 'POST');
    await click(button(issueCard, 'Resolve issue'));
    assert.deepEqual(api.calls.find(({ pathname, method }) => pathname === resolvePath && method === 'POST')?.body, { version: 1, resolution });

    const committed = detailFixture(2);
    committed.delivery.issues = [{ ...issue, status: 'resolved', resolution, resolvedBy: user.id, resolvedAt: '2026-11-16T10:15:00Z' }];
    committed.progress = 'awaiting_closure';
    committed.views = [];
    committed.closureBlockers = [];
    await act(async () => { pendingResolution.reply(committed); });

    await waitFor(() => completion.textContent?.includes('All completion conditions are satisfied.') === true, 'updated completion review');
    assert.equal(document.querySelector('.delivery-panel'), panel);
    assert.equal(button(panel, 'Issues & returns').getAttribute('aria-pressed'), 'true');
    assert.doesNotMatch(completion.textContent ?? '', /Open issues remain|The record has newer data|Use latest data/u);
    assert.doesNotMatch(registrationEditor.textContent ?? '', /The record has newer data|Use latest data/u);
    assert.match(panel.textContent ?? '', /All issues resolved/u);
    assert.equal(issueCard.querySelector('textarea[name="resolution"]'), null);
    assert.match(issueCard.textContent ?? '', /resolved.*Site access checked and cleared\./su);
    assert.equal(notesEditor.open, true);
    assert.equal(notesDraft.value, 'Separate unsaved issue note.');
    assert.match(notesEditor.textContent ?? '', /The record has newer data/u);

    const completePath = `/deliveries/${deliveryId}/complete`;
    const pendingCompletion = api.defer(completePath, 'POST');
    await click(button(completion, 'Verify & complete delivery'));
    assert.deepEqual(api.calls.find(({ pathname, method }) => pathname === completePath && method === 'POST')?.body, { version: 2 });
    committed.delivery.version = 3;
    committed.delivery.completedAt = '2026-11-16T10:20:00Z';
    committed.progress = 'completed';
    await act(async () => { pendingCompletion.reply(committed); });
    await waitFor(() => completion.textContent?.includes('Delivery completed') === true, 'completed delivery');
  } finally { await page.close(); }
});
