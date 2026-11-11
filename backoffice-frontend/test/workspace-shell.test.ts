import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { ApiFixture, click, domHarness, editInput, waitFor } from './refresh-fixtures';

const preferenceKey = 'backoffice.sidebar.collapsed';

function namedButton(scope: ParentNode, name: string) {
  const found = Array.from(scope.querySelectorAll('button')).find((element) => element.getAttribute('aria-label') === name);
  assert.ok(found, `Missing button: ${name}`);
  return found;
}

async function shellView(onNavigate = () => {}) {
  const { WorkspaceShell, WorkspaceNav } = await import('../src/components/workspace-shell');
  const props = {
    navigation: createElement('nav', { 'aria-label': 'Example sections' }, createElement(WorkspaceNav, {
      href: undefined, label: 'Calendar', icon: '▦', className: 'nav-item', onClick: onNavigate,
    })),
    header: createElement('span', null, 'Current page'),
    children: createElement('section', null, createElement('input', { name: 'draft', defaultValue: 'Saved value' })),
  };
  return createElement(WorkspaceShell, props);
}

void test('sidebar collapse preserves page draft and scroll, persists preference and restores it on remount', async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const view = await shellView();
    await page.render(view);
    const document = page.dom.window.document;
    const input = document.querySelector('input[name="draft"]');
    const main = document.querySelector('main');
    assert.ok(input instanceof HTMLInputElement && main);
    await editInput(input, 'Unsaved delivery notes');
    main.scrollTop = 280;
    await click(namedButton(document, 'Collapse navigation'));
    assert.equal(namedButton(document, 'Expand navigation').getAttribute('aria-expanded'), 'false');
    assert.equal(page.dom.window.localStorage.getItem(preferenceKey), 'true');
    assert.equal(document.querySelector('main'), main);
    assert.equal(document.querySelector('input[name="draft"]'), input);
    assert.equal(input.value, 'Unsaved delivery notes');
    assert.equal(main.scrollTop, 280);
    assert.equal(namedButton(document, 'Calendar').getAttribute('aria-label'), 'Calendar');
    await page.render(null);
    await page.render(view);
    assert.equal(namedButton(document, 'Expand navigation').getAttribute('aria-expanded'), 'false');
    await click(namedButton(document, 'Expand navigation'));
    assert.equal(page.dom.window.localStorage.getItem(preferenceKey), 'false');
    assert.equal(namedButton(document, 'Collapse navigation').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(api.calls, []);
  } finally { await page.close(); }
});

void test('invalid or blocked storage does not prevent opening and closing navigation', async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const view = await shellView();
    page.dom.window.localStorage.setItem(preferenceKey, 'not-a-boolean');
    await page.render(view);
    assert.equal(namedButton(page.dom.window.document, 'Collapse navigation').getAttribute('aria-expanded'), 'true');
    await page.render(null);
    Object.defineProperty(page.dom.window, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked by browser policy'); } });
    await page.render(view);
    await click(namedButton(page.dom.window.document, 'Collapse navigation'));
    await click(namedButton(page.dom.window.document, 'Expand navigation'));
    assert.equal(namedButton(page.dom.window.document, 'Collapse navigation').getAttribute('aria-expanded'), 'true');
  } finally { await page.close(); }
});

void test('mobile navigation closes by button, Escape and selected section while returning focus and retaining page state', async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  let selections = 0;
  try {
    await page.render(await shellView(() => { selections += 1; }));
    const document = page.dom.window.document;
    const trigger = namedButton(document, 'Open navigation');
    const input = document.querySelector('input[name="draft"]');
    assert.ok(input instanceof HTMLInputElement);
    const draft = input;
    await editInput(input, 'Retained across mobile menu');

    async function open() {
      trigger.focus();
      await click(trigger);
      await waitFor(() => document.querySelector('[role="dialog"]') !== null, 'navigation dialog');
      const dialog = document.querySelector('[role="dialog"]');
      assert.ok(dialog);
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(dialog.id, trigger.getAttribute('aria-controls'));
      assert.ok(dialog.contains(document.activeElement), 'Focus must enter the navigation dialog');
      return dialog;
    }
    async function closed() {
      await waitFor(() => document.querySelector('[role="dialog"]') === null, 'navigation close');
      await waitFor(() => document.activeElement === trigger, 'focus returns to mobile menu trigger');
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(document.querySelector('input[name="draft"]'), draft);
      assert.equal(draft.value, 'Retained across mobile menu');
    }

    let dialog = await open();
    await click(namedButton(dialog, 'Close navigation'));
    await closed();
    dialog = await open();
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await closed();
    dialog = await open();
    await click(namedButton(dialog, 'Calendar'));
    await closed();
    assert.equal(selections, 1);
    assert.deepEqual(api.calls, []);
  } finally { await page.close(); }
});

void test('Backoffice sidebar toggles retain the loaded delivery row without fetching or resetting the selected view', async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table tbody tr') !== null, 'Inbox row');
    const row = document.querySelector('.delivery-table tbody tr');
    const table = document.querySelector('.table-wrap');
    assert.ok(row && table);
    table.scrollLeft = 240;
    const calls = api.calls.length;
    await click(namedButton(document, 'Collapse navigation'));
    await click(namedButton(document, 'Expand navigation'));
    assert.equal(document.querySelector('.delivery-table tbody tr'), row);
    assert.equal(document.querySelector('.table-wrap'), table);
    assert.equal(table.scrollLeft, 240);
    assert.equal(namedButton(document, 'Inbox to plan').getAttribute('aria-current'), 'page');
    assert.equal(api.calls.length, calls);
  } finally { await page.close(); }
});
