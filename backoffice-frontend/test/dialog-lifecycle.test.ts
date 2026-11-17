import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { ApiFixture, button, click, domHarness, waitFor } from './refresh-fixtures';

void test('closing retains the record for its exit, and reopening cancels an earlier pending dismissal', { concurrency: false }, async () => {
  const page = await domHarness(new ApiFixture());
  class MediaQuery extends page.dom.window.EventTarget implements MediaQueryList {
    readonly matches = false;
    readonly media = '(prefers-reduced-motion: reduce)';
    onchange: MediaQueryList['onchange'] = null;
    addListener(): void { /* This fixed preference never changes. */ }
    removeListener(): void { /* This fixed preference never changes. */ }
  }
  const matchMedia: Window['matchMedia'] = () => new MediaQuery();
  Object.defineProperty(page.dom.window, 'matchMedia', { configurable: true, value: matchMedia });
  try {
    const { useDialogState } = await import('../src/components/ui/dialog');
    function Fixture() {
      const [record, change, open] = useDialogState<string>();
      return createElement('div', null,
        createElement('button', { onClick: () => change('first') }, 'Open first'),
        createElement('button', { onClick: () => change('second') }, 'Open second'),
        createElement('button', { onClick: () => change(null) }, 'Close'),
        createElement('output', { 'data-open': open }, record ?? 'unmounted'));
    }
    await page.render(createElement(Fixture));
    const document = page.dom.window.document;
    await click(button(document, 'Open first'));
    await click(button(document, 'Close'));
    assert.equal(document.querySelector('output')?.textContent, 'first', 'The former record stays available to render the exit animation');
    assert.equal(document.querySelector('output')?.getAttribute('data-open'), 'false');
    await click(button(document, 'Open second'));
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 220)); });
    assert.equal(document.querySelector('output')?.textContent, 'second', 'An obsolete dismissal cannot remove a reopened dialog');
    assert.equal(document.querySelector('output')?.getAttribute('data-open'), 'true');
    await click(button(document, 'Close'));
    await waitFor(() => document.querySelector('output')?.textContent === 'unmounted', 'exit completes');
  } finally { await page.close(); }
});
