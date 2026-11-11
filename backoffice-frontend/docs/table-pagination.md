# Shared table pagination — 2026-11-10

`src/components/ui/data-table.tsx` owns the accessible table shell and pagination for all nine Backoffice record tables. Each page contains at most **10 rows**. The footer shows the visible range, total rows, current page, and navigation controls. Labels are available in English, Italian, Russian and Uzbek.

Consumers: delivery lists, Calendar's appointment list, Visit staffing, Crews, Participants, Skills, participant skill assignments, Vehicles and Source sync history. Task templates remain cards. The month calendar is a date matrix and remains complete; only the appointment list below it is paginated.

## State and data

- The complete fetched collection remains available for filters, choices, counters, calendar blocks and editing. Only table rows are sliced. Visit staffing counts one row per crew assignment, including a single placeholder row for an unstaffed visit.
- Refresh retains the current page and mounted table. Stable row keys preserve open disclosures; editors and their unsaved values remain outside the table. Refresh failures keep the last loaded rows.
- Changing search/filter/date range returns the affected list to page 1. Removing the final row on a later page moves to the last available page. Creating more rows afterwards does not silently restore the old page.
- Delivery lists keep their existing server pagination. Controlled mode displays the returned rows without slicing them again. If Refresh reports that the requested page is no longer available, Backoffice requests the new last page before replacing the displayed data.
- A filter's `resetKey` must describe the filter, not the Refresh revision. Do not key/remount the table to refresh data.
- Table horizontal overflow stays in its existing wrapper; the footer stays outside that scroll area.

## Local commands

The backend API and PostgreSQL use the existing Docker stack; no database or API changes are needed for this UI change.

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

Open http://127.0.0.1:3000. Participants provides a two-page example with the existing 20 demo accounts. No additional demo records or mutations are required.

## Verification

On 2026-11-10, typecheck, full typed lint, all **164 frontend tests**, and the production build passed. Relevant regression files: `data-table.test.ts`, `directory-pagination.test.ts`, `calendar-table-pagination.test.ts`, `workspace-pagination.test.ts`, plus existing Refresh, geography and CRUD suites.

Chrome against the running Docker API showed: Participants 10+10; participant skills 10+10; Inbox 10+6; Source sync 10 per page from its existing 100-run response; Calendar 8; Crews 6; Skills 9; Vehicles 5; Visit staffing 1 on November 11. Source sync Refresh retained page 2 and expanded diagnostics; Inbox Refresh retained page 2 and selecting Catania reset it to page 1 with seven matching deliveries. A participant editor opened from page 2 and was closed without saving.

Both light and dark themes were inspected. At a 320 px viewport, the footer fit its 270 px content area without horizontal overflow; wide table content retained its internal horizontal scroll. The viewport was reset and Light restored. Browser console contained no warnings/errors. The updated Participants page 2 remains open in Chrome. Business data were not changed by this verification. [Browser screenshot](screenshots/table-pagination.png).

No backend source or migrations changed, so backend/PostgreSQL suites were not rerun for this frontend-only task. The installed Node/tsx runner emits its existing `module.register()` deprecation warning; checks still pass.
