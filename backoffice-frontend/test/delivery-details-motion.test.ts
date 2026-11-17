import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { appointmentSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, deliveryId, domHarness, user, waitFor } from './refresh-fixtures';

void test('reduced-motion preference removes panel and scheduling translation while navigation and Escape remain usable', { concurrency: false }, async () => {
  const api = new ApiFixture();
  api.detail.delivery.appointments = [appointmentSchema.parse({ id: '89000000-0000-4000-8000-000000000001', startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T10:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null, assignments: [], results: [] })];
  const page = await domHarness(api);
  const queried: string[] = [];
  // The preference is fixed for this isolated process; it never emits a change.
  class FixedMediaQuery extends page.dom.window.EventTarget implements MediaQueryList {
    readonly matches: boolean;
    onchange: MediaQueryList['onchange'] = null;
    private readonly legacyListeners = new Set<(this: MediaQueryList, event: MediaQueryListEvent) => void>();
    constructor(readonly media: string) { super(); this.matches = media.includes('prefers-reduced-motion') && !media.includes('no-preference'); }
    addListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null): void { if (listener) this.legacyListeners.add(listener); }
    removeListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null): void { if (listener) this.legacyListeners.delete(listener); }
  }
  const matchMedia: Window['matchMedia'] = (query) => { queried.push(query); return new FixedMediaQuery(query); };
  Object.defineProperty(page.dom.window, 'matchMedia', { configurable: true, value: matchMedia });
  let closed = false;
  async function animationFrames(selector: string) {
    const snapshots: Array<{ transform: string; opacity: string }> = [];
    for (let index = 0; index < 5; index += 1) {
      await act(async () => { await new Promise<void>((resolve) => { page.dom.window.requestAnimationFrame(() => resolve()); }); });
      const element = page.dom.window.document.querySelector(selector); assert.ok(element instanceof page.dom.window.HTMLElement);
      snapshots.push({ transform: element.style.transform, opacity: element.style.opacity });
    }
    assert.ok(snapshots.some((sample) => Number(sample.opacity) > 0), 'The actual animation must advance; a frozen JSDOM frame loop cannot prove reduced motion');
    return snapshots;
  }
  function untranslated(snapshots: Array<{ transform: string; opacity: string }>) {
    for (const snapshot of snapshots) assert.ok(snapshot.transform === '' || snapshot.transform === 'none', `Reduced motion must not translate content: ${JSON.stringify(snapshot)}`);
  }
  try {
    // Import after matchMedia is available: Motion reads the real preference at mount.
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    const { motion, MotionConfig } = await import('motion/react');
    // Calibrate the observable behavior: the same sampler must detect actual movement
    // when a synthetic control deliberately opts out of the user's fixed preference.
    // A long duration keeps this control moving throughout the five-frame sample.
    await page.render(createElement(MotionConfig, { reducedMotion: 'never' }, createElement(motion.div, { className: 'motion-observation-control', initial: { opacity: 0, y: 40 }, animate: { opacity: 1, y: 0 }, transition: { duration: 10, ease: 'linear' } }, 'Synthetic motion calibration')));
    const movingControl = await animationFrames('.motion-observation-control');
    assert.ok(movingControl.some((sample) => Number(sample.opacity) > 0 && sample.transform !== '' && sample.transform !== 'none'), 'The sampler must detect actual nonzero translation; a settled control cannot prove reduced-motion behavior');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => { closed = true; }, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.detail-tab-content') !== null, 'panel content');
    const panelFrames = await animationFrames('.detail-tab-content');
    untranslated(panelFrames);
    assert.ok(queried.some((query) => query.includes('prefers-reduced-motion')), 'The installed animation integration must read the reduced preference');
    assert.match(document.body.textContent ?? '', /DEMO original customer/);
    const visits = button(document, 'Visits & tasks'); visits.focus(); assert.strictEqual(document.activeElement, visits); await click(visits);
    assert.equal(visits.getAttribute('aria-pressed'), 'true');
    const trigger = button(document, 'Manage assignment, reschedule or cancel ↓'); trigger.focus(); assert.strictEqual(document.activeElement, trigger); await click(trigger);
    const scheduling = document.querySelector('.visit-editor');
    assert.ok(scheduling instanceof page.dom.window.HTMLElement);
    assert.equal(scheduling.getAttribute('role'), 'dialog');
    assert.ok(scheduling.contains(document.activeElement), 'Opening scheduling moves focus into its modal');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    await click(button(document, 'Hide scheduling actions ↑')); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.ok(panelFrames.length > 0);
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    assert.equal(closed, true, 'The dialog Escape handler remains usable with reduced motion');
  } finally { await page.close(); }
});
