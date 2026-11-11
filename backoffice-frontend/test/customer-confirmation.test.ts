import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { appointmentSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, deliveryId, domHarness, user, waitFor } from './refresh-fixtures';

void test('the visit displays the saved customer confirmation and retains it in cancelled visit history', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const staffedVisit = appointmentSchema.parse({
    id: '88000000-0000-4000-8000-000000000060',
    startsAt: '2026-11-10T08:00:00Z',
    endsAt: '2026-11-10T10:00:00Z',
    status: 'booked',
    cancellationReason: null,
    returnRequestId: null,
    assignments: [{
      id: '88000000-0000-4000-8000-000000000061',
      crewId: '88000000-0000-4000-8000-000000000062',
      crewName: 'DEMO confirmation crew',
      people: [{ id: '88000000-0000-4000-8000-000000000063', name: 'DEMO confirmation worker', external: false }],
      tasks: [],
    }],
    results: [],
  });
  const unstaffedVisit = appointmentSchema.parse({ ...staffedVisit, id: '88000000-0000-4000-8000-000000000064', assignments: [] });
  api.detail.delivery.appointments = [staffedVisit, unstaffedVisit];

  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.panel-meta') !== null, 'delivery details');
    await click(button(document, 'Visits & tasks'));

    const sections = document.querySelectorAll('.visit-card section[aria-label="Customer confirmation"]');
    assert.equal(sections.length, 1, 'An unstaffed visit does not offer customer confirmation');
    const section = sections[0];
    assert.ok(section);
    assert.match(section.textContent ?? '', /Awaiting customer confirmation/);
    assert.match(section.textContent ?? '', /after the customer agrees to the visit date and time/);
    const action = button(section, 'Record customer confirmation');
    const path = `/deliveries/${deliveryId}/appointments/${staffedVisit.id}/confirm-customer`;
    const response = api.defer(path, 'POST');
    await click(action);
    assert.deepEqual(api.calls.filter((call) => call.method !== 'GET').map((call) => ({ path: call.pathname, body: call.body })), [{ path, body: { version: 1 } }]);
    assert.match(section.textContent ?? '', /Awaiting customer confirmation/);
    assert.doesNotMatch(section.textContent ?? '', /Customer confirmed/);
    assert.equal(action.disabled, true);

    const confirmedVisit = appointmentSchema.parse({
      ...staffedVisit,
      customerConfirmation: { confirmedAt: '2026-11-04T09:15:00Z', confirmedBy: { id: user.id, name: user.name } },
    });
    api.detail.delivery = { ...api.detail.delivery, version: 2, appointments: [confirmedVisit, unstaffedVisit] };
    await act(async () => { response.reply(api.detail); });
    await waitFor(() => section.textContent?.includes('Customer confirmed') === true, 'saved customer confirmation');
    assert.match(section.textContent ?? '', /Recorded by DEMO operator · 04 Nov 2026, 10:15 UTC\+01:00/);
    assert.equal(section.querySelector('button'), null, 'A recorded confirmation has no duplicate action');

    api.detail.delivery = {
      ...api.detail.delivery,
      version: 3,
      appointments: [{ ...confirmedVisit, status: 'cancelled', cancellationReason: 'DEMO cancellation after customer agreed' }, unstaffedVisit],
    };
    await click(button(document, '↻ Refresh'));
    await waitFor(() => document.querySelectorAll('.visit-card').length === 1, 'cancelled visit removed from the working list');
    await click(button(document, 'History'));
    const historical = document.querySelector('.detail-tab-history section[aria-label="Customer confirmation"]');
    assert.ok(historical);
    assert.match(historical.textContent ?? '', /Customer confirmed.*Recorded by DEMO operator/s);
    assert.equal(historical.querySelector('button'), null);
  } finally { await page.close(); }
});
