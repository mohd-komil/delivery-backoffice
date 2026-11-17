import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { ApiFixture, button, click, domHarness, editInput } from './refresh-fixtures';

void test('Calendar selection and time editing retain Rome resolution and initial subminute precision', { concurrency: false }, async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const { DateTimeInput } = await import('../src/components/date-time-fields');
    await page.render(createElement(DateTimeInput, { name: 'startsAt', label: 'Starts at', initialInstant: '2026-01-15T08:15:12.250Z' }));
    const document = page.dom.window.document;
    const trigger = document.querySelector('button[aria-label="Starts at"]');
    assert.ok(trigger instanceof HTMLButtonElement);
    await click(trigger);
    const day = document.querySelector('button[aria-label="Friday, 16 January 2026"]');
    assert.ok(day instanceof HTMLButtonElement);
    await click(day);
    const resolved = document.querySelector('input[name="startsAt"]');
    assert.ok(resolved instanceof HTMLInputElement);
    assert.equal(resolved.value, '2026-01-16T08:15:12.250Z');
    const time = document.querySelector('input[type="time"]');
    assert.ok(time instanceof HTMLInputElement);
    await editInput(time, '10:45:15.125');
    assert.equal(resolved.value, '2026-01-16T09:45:15.125Z');
    await click(button(document, 'Done'));
    assert.equal(document.querySelector('[data-slot="popover-content"]'), null);
  } finally { await page.close(); }
});

void test('Month picker selects a month without inventing a day; required empty picker focuses its visible trigger', { concurrency: false }, async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const { DatePicker } = await import('../src/components/ui/date-picker');
    let selected = '';
    await page.render(createElement('form', null, createElement(DatePicker, { label: 'Calendar month', type: 'month', value: '2026-11', onValueChange: (value) => { selected = value; } })));
    const document = page.dom.window.document;
    const trigger = document.querySelector('button[aria-label="Calendar month"]');
    assert.ok(trigger instanceof HTMLButtonElement);
    await click(trigger);
    await click(button(document, 'Dec'));
    assert.equal(selected, '2026-12');
    await page.render(createElement('form', null, createElement(DatePicker, { label: 'Required day', type: 'date', required: true, value: '', onValueChange: () => undefined })));
    const form = document.querySelector('form');
    assert.ok(form);
    await act(async () => { assert.equal(form.checkValidity(), false); });
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Required day');
  } finally { await page.close(); }
});
