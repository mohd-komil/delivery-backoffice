import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, useState } from 'react';
import { ApiFixture, domHarness, editInput, waitFor } from './refresh-fixtures';

void test('searchable combobox preserves native form/change contracts, disabled options, reset and refresh', { concurrency: false }, async () => {
  const page = await domHarness(new ApiFixture());
  const { Combobox } = await import('../src/components/ui/combobox');
  const { Dialog, DialogContent, DialogTitle } = await import('../src/components/ui/dialog');
  const resizeOriginal = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const scrollOriginal = Object.getOwnPropertyDescriptor(page.dom.window.HTMLElement.prototype, 'scrollIntoView');
  class TestResizeObserver implements ResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver });
  Object.defineProperty(page.dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  const seen: string[] = [];
  const options = [createElement('option', { value: '', key: '' }, 'Choose crew'),
    createElement('option', { value: 'messina', key: 'messina' }, 'Messina Uno'),
    createElement('option', { value: 'catania', key: 'catania', disabled: true }, 'Catania — unavailable'),
    ...['Palermo', 'Trapani', 'Cefalù', 'Milazzo'].map((name) => createElement('option', { value: name, key: name }, name))];
  function Form({ updated = false, compact = false }: { updated?: boolean; compact?: boolean }) {
    const [controlled, setControlled] = useState('messina');
    return createElement(Dialog, { open: true }, createElement(DialogContent, { 'aria-describedby': undefined },
      createElement(DialogTitle, null, 'Crew assignment'), createElement('form', null,
      createElement('label', null, 'Crew', createElement(Combobox, { name: 'crew', 'aria-label': 'Crew', required: true,
        defaultValue: '', onChange(event) { seen.push(event.currentTarget.value); } }, compact ? options.slice(0, 6) : options,
      updated && !compact ? createElement('option', { value: 'new' }, 'New available crew') : null)),
      createElement(Combobox, { name: 'controlled', 'aria-label': 'Controlled', value: controlled,
        onChange(event) { setControlled(event.target.value); } }, options),
      createElement(Combobox, { name: 'small', 'aria-label': 'Five crews', defaultValue: '' }, options.slice(0, 6)),
      createElement('button', { type: 'reset' }, 'Reset'))));
  }
  try {
    await page.render(createElement(Form));
    const document = page.dom.window.document;
    const trigger = document.querySelector('[role="combobox"][aria-label="Crew"]');
    assert.ok(trigger instanceof HTMLButtonElement);
    const select = document.querySelector('select[name="crew"]');
    assert.ok(select instanceof HTMLSelectElement);
    const form = select.form; assert.ok(form);
    await act(async () => { assert.equal(form.checkValidity(), false); });
    assert.equal(document.activeElement, trigger);
    assert.equal(trigger.getAttribute('aria-invalid'), 'true');
    assert.equal(select.getAttribute('aria-hidden'), 'true');
    await act(async () => { trigger.click(); });
    await waitFor(() => document.querySelector('[cmdk-input]') !== null, 'combobox search');
    assert.equal(document.querySelectorAll('[cmdk-item]').length, 7, 'Six records plus an empty placeholder have search; disabled records count');
    const search = document.querySelector('[cmdk-input]'); assert.ok(search instanceof HTMLInputElement);
    assert.equal(document.activeElement, search);
    const disabled = [...document.querySelectorAll('[cmdk-item]')].find((item) => item.textContent?.includes('Catania'));
    assert.ok(disabled instanceof HTMLElement); assert.equal(disabled.getAttribute('aria-disabled'), 'true');
    await act(async () => { disabled.click(); });
    assert.equal(select.value, '');
    await editInput(search, 'Messina');
    await waitFor(() => document.querySelectorAll('[cmdk-item]').length === 1, 'filtered options');
    const found = document.querySelector('[cmdk-item]'); assert.ok(found instanceof HTMLElement);
    await act(async () => { found.click(); });
    assert.equal(select.value, 'messina');
    assert.deepEqual(seen, ['messina']);
    assert.equal(new FormData(form).get('crew'), 'messina');
    assert.match(trigger.textContent ?? '', /Messina Uno/);
    assert.equal(trigger.getAttribute('aria-invalid'), null);
    await page.render(createElement(Form, { updated: true }));
    assert.strictEqual(document.querySelector('select[name="crew"]'), select);
    assert.equal(select.value, 'messina');
    await act(async () => { form.reset(); });
    await waitFor(() => trigger.textContent?.includes('Choose crew') === true, 'reset label');
    assert.equal(select.value, '');
    const controlled = document.querySelector('select[name="controlled"]'); assert.ok(controlled instanceof HTMLSelectElement);
    await act(async () => { controlled.value = ''; controlled.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.match(document.querySelector('[role="combobox"][aria-label="Controlled"]')?.textContent ?? '', /Choose crew/);
    await act(async () => { trigger.click(); });
    const keyboardSearch = document.querySelector('[cmdk-input]'); assert.ok(keyboardSearch instanceof HTMLInputElement);
    await act(async () => { keyboardSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    await act(async () => { keyboardSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    assert.equal(select.value, 'messina', 'Keyboard selection skips the disabled option and uses the same form event');
    assert.equal(document.activeElement, trigger, 'Closing the popup restores focus inside the assignment dialog');
    await act(async () => { trigger.click(); });
    const escapeSearch = document.querySelector('[cmdk-input]'); assert.ok(escapeSearch instanceof HTMLInputElement);
    await act(async () => { escapeSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, 'Escape closes only the combobox popup');
    const smallTrigger = document.querySelector('[role="combobox"][aria-label="Five crews"]'); assert.ok(smallTrigger instanceof HTMLButtonElement);
    await act(async () => { smallTrigger.click(); });
    assert.equal(document.querySelector('[cmdk-input]'), null, 'Five records plus an empty placeholder do not show search');
    assert.equal(document.querySelectorAll('[cmdk-item]').length, 6);
    const command = document.querySelector('[cmdk-root]'); assert.ok(command instanceof HTMLElement);
    assert.equal(document.activeElement, command, 'The option list receives keyboard focus without an input');
    await act(async () => { command.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    await act(async () => { command.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    assert.equal(new FormData(form).get('small'), 'messina');
    assert.equal(document.activeElement, smallTrigger);
    await act(async () => { trigger.click(); });
    const shrinkingSearch = document.querySelector('[cmdk-input]'); assert.ok(shrinkingSearch instanceof HTMLInputElement);
    await editInput(shrinkingSearch, 'No matching crew');
    assert.equal(document.querySelectorAll('[cmdk-item]').length, 0);
    await page.render(createElement(Form, { compact: true }));
    assert.equal(document.querySelector('[cmdk-input]'), null);
    assert.equal(document.querySelectorAll('[cmdk-item]').length, 6, 'A shrinking list must not retain invisible search filtering');
    assert.equal(document.querySelector('[cmdk-empty]'), null);
    assert.equal(document.activeElement, document.querySelector('[cmdk-root]'), 'Refresh transfers focus when it removes the search input');
    assert.equal(select.value, 'messina');
    await act(async () => { smallTrigger.focus(); smallTrigger.click(); });
    await waitFor(() => document.querySelector('[data-slot="popover-content"][aria-label="Five crews"]') !== null, 'second popup');
    assert.equal(smallTrigger.getAttribute('aria-expanded'), 'true');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, document.querySelector('[cmdk-root]'), 'Closing the old popup must not steal the new popup focus');
  } finally {
    await page.close();
    if (resizeOriginal) Object.defineProperty(globalThis, 'ResizeObserver', resizeOriginal); else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    if (scrollOriginal) Object.defineProperty(page.dom.window.HTMLElement.prototype, 'scrollIntoView', scrollOriginal);
    else Reflect.deleteProperty(page.dom.window.HTMLElement.prototype, 'scrollIntoView');
  }
});
