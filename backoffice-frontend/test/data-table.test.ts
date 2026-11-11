import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { DataTable } from '../src/components/ui/data-table';
import { ApiFixture, button, click, domHarness, editInput } from './refresh-fixtures';

function rows(count: number, start = 1, revision = 0) {
  return Array.from({ length: count }, (_, index) => {
    const id = start + index;
    return createElement('tr', { key: id, 'data-row-id': id },
      createElement('td', null, `Record ${id}${revision > 0 ? ' refreshed' : ''}`),
      createElement('td', null, createElement('input', { 'aria-label': `Note ${id}`, defaultValue: '' })));
  });
}

function table(count: number, props: Partial<ComponentProps<typeof DataTable>> = {}) {
  return createElement(DataTable, {
    caption: 'Records',
    header: createElement('tr', null, createElement('th', { scope: 'col' }, 'Name'), createElement('th', { scope: 'col' }, 'Note')),
    rows: rows(count),
    emptyRow: createElement('tr', null, createElement('td', { colSpan: 2 }, 'No records')),
    ...props,
  });
}

function rowIds(document: Document) {
  return Array.from(document.querySelectorAll('tbody tr[data-row-id]'), (row) => row.getAttribute('data-row-id'));
}

function range(document: Document) {
  return document.querySelector('nav [aria-live="polite"]')?.textContent;
}

for (const count of [0, 10, 11, 21]) {
  void test(`DataTable paginates ${count} records with disabled boundaries and accessible controls`, { concurrency: false }, async () => {
    const page = await domHarness(new ApiFixture());
    try {
      await page.render(table(count));
      const document = page.dom.window.document;
      const next = button(document, 'Next');
      const previous = button(document, 'Previous');
      assert.equal(previous.disabled, true);
      assert.equal(previous.getAttribute('aria-label'), 'Previous page');
      assert.equal(next.getAttribute('aria-label'), 'Next page');
      assert.equal(next.type, 'button');
      assert.equal(previous.type, 'button');
      assert.equal(document.querySelector('caption')?.textContent, 'Records');
      assert.equal(document.querySelector('.table-wrap nav'), null, 'Pagination stays outside the scrolling wrapper');
      assert.equal(document.querySelector('nav')?.getAttribute('aria-label'), 'Records pagination');
      assert.equal(next.getAttribute('aria-controls'), document.querySelector('table')?.id);
      assert.equal(rowIds(document).length, Math.min(10, count));
      assert.equal(range(document), `${count === 0 ? 0 : 1}–${Math.min(10, count)} of ${count}`);
      assert.equal(next.disabled, count <= 10);
      if (count === 0) assert.equal(document.querySelector('tbody')?.textContent, 'No records');

      let currentPage = 1;
      while (!next.disabled) {
        await click(next);
        currentPage += 1;
        assert.equal(previous.disabled, false);
        const first = (currentPage - 1) * 10 + 1;
        const last = Math.min(currentPage * 10, count);
        assert.deepEqual(rowIds(document), Array.from({ length: last - first + 1 }, (_, index) => String(first + index)));
        assert.equal(range(document), `${first}–${last} of ${count}`);
        assert.ok(document.querySelector('nav')?.textContent.includes(`Page ${currentPage} of ${Math.max(1, Math.ceil(count / 10))}`));
      }
      assert.equal(currentPage, Math.max(1, Math.ceil(count / 10)));
      while (!previous.disabled) await click(previous);
      assert.equal(rowIds(document)[0], count === 0 ? undefined : '1');
    } finally { await page.close(); }
  });
}

void test('DataTable resets on filter change and persists a clamped page after deletion', { concurrency: false }, async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const document = page.dom.window.document;
    await page.render(table(21, { resetKey: 'all' }));
    await click(button(document, 'Next'));
    await click(button(document, 'Next'));
    assert.deepEqual(rowIds(document), ['21']);

    await page.render(table(20, { resetKey: 'all' }));
    assert.equal(rowIds(document)[0], '11');
    assert.equal(range(document), '11–20 of 20');
    await page.render(table(21, { resetKey: 'all' }));
    assert.equal(rowIds(document)[0], '11', 'A refreshed extra record must not restore the removed page');
    assert.equal(range(document), '11–20 of 21');

    await page.render(table(21, { resetKey: 'available' }));
    assert.equal(rowIds(document)[0], '1');
    assert.equal(button(document, 'Previous').disabled, true);
    await click(button(document, 'Next'));
    await page.render(table(0, { resetKey: 'available' }));
    assert.equal(range(document), '0–0 of 0');
    await page.render(table(21, { resetKey: 'available' }));
    assert.equal(rowIds(document)[0], '1');
  } finally { await page.close(); }
});

void test('DataTable refresh preserves page, table, rows, focus, scrolling and unsaved inputs', { concurrency: false }, async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const document = page.dom.window.document;
    await page.render(table(21, { resetKey: 'all', containerClassName: 'relative', className: 'directory-table' }));
    await click(button(document, 'Next'));
    const tableNode = document.querySelector('table');
    const rowNode = document.querySelector('tbody tr');
    const wrapper = document.querySelector('.table-wrap');
    const input = document.querySelector('input[aria-label="Note 11"]');
    assert.ok(input instanceof HTMLInputElement);
    assert.ok(wrapper instanceof HTMLElement);
    assert.ok(wrapper.classList.contains('relative'));
    assert.ok(tableNode?.classList.contains('directory-table'));
    await editInput(input, 'Unsaved note');
    input.focus();
    wrapper.scrollLeft = 160;
    wrapper.scrollTop = 40;

    await page.render(table(21, { resetKey: 'all', rows: rows(21, 1, 1), containerClassName: 'relative', className: 'directory-table' }));
    assert.equal(document.querySelector('table'), tableNode);
    assert.equal(document.querySelector('tbody tr'), rowNode);
    assert.equal(document.querySelector('input[aria-label="Note 11"]'), input);
    assert.equal(input.value, 'Unsaved note');
    assert.equal(document.activeElement, input);
    assert.equal(wrapper.scrollLeft, 160);
    assert.equal(wrapper.scrollTop, 40);
    assert.equal(range(document), '11–20 of 21');
    assert.ok(rowNode?.textContent.includes('Record 11 refreshed'));
  } finally { await page.close(); }
});

void test('DataTable renders controlled server pages exactly once and disables navigation while refreshing', { concurrency: false }, async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const document = page.dom.window.document;
    const changes: number[] = [];
    const pagination = { page: 2, pageSize: 10, total: 21, onPageChange: (nextPage: number) => { changes.push(nextPage); } };
    await page.render(table(10, { rows: rows(10, 11), pagination }));
    assert.deepEqual(rowIds(document), Array.from({ length: 10 }, (_, index) => String(index + 11)));
    assert.equal(range(document), '11–20 of 21');
    const rowNode = document.querySelector('tbody tr');
    await click(button(document, 'Next'));
    assert.deepEqual(changes, [3]);
    assert.equal(rowIds(document)[0], '11', 'The caller owns server-page transitions');

    await page.render(table(10, { rows: rows(10, 11), pagination: { ...pagination, disabled: true } }));
    assert.equal(button(document, 'Previous').disabled, true);
    assert.equal(button(document, 'Next').disabled, true);
    assert.equal(document.querySelector('tbody tr'), rowNode);
    await page.render(table(1, { rows: rows(1, 21), pagination: { ...pagination, page: 3 } }));
    assert.deepEqual(rowIds(document), ['21']);
    assert.equal(range(document), '21–21 of 21');
    assert.equal(button(document, 'Next').disabled, true);
    await click(button(document, 'Previous'));
    assert.deepEqual(changes, [3, 2]);
  } finally { await page.close(); }
});

void test('DataTable translates range, page and navigation in all four supported languages without resetting the page', { concurrency: false }, async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const document = page.dom.window.document;
    await page.render(table(11));
    await click(button(document, 'Next'));
    const translations = [
      { locale: 'en', range: '11–11 of 11', page: 'Page 2 of 2', previous: 'Previous page', next: 'Next page' },
      { locale: 'it', range: '11–11 di 11', page: 'Pagina 2 di 2', previous: 'Pagina precedente', next: 'Pagina successiva' },
      { locale: 'ru', range: '11–11 из 11', page: 'Страница 2 из 2', previous: 'Предыдущая страница', next: 'Следующая страница' },
      { locale: 'uz', range: '11 tadan 11–11', page: '2 sahifadan 2-sahifa', previous: 'Oldingi sahifa', next: 'Keyingi sahifa' },
    ] as const;
    for (const translation of translations) {
      await page.render(table(11), translation.locale);
      assert.equal(range(document), translation.range);
      assert.ok(document.querySelector('nav')?.textContent.includes(translation.page));
      const controls = Array.from(document.querySelectorAll('nav button'));
      assert.deepEqual(controls.map((control) => control.getAttribute('aria-label')), [translation.previous, translation.next]);
      assert.deepEqual(rowIds(document), ['11']);
    }
  } finally { await page.close(); }
});
