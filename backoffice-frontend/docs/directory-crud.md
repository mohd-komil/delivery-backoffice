# Participants, Crews and Task templates

All three directories support creating, viewing, editing and deleting records. Operators can view full details; administrators manage the records. In the interface, participant login and password-configuration status are visible only to administrators. The existing authenticated Backoffice API still returns login and password-configuration status to operators; password values and hashes are never returned or shown.

Use **View** from a row or template card for a read-only detail dialog. Existing edit forms retain their original version while refreshing, including unsaved input. **Delete** opens a named confirmation with Cancel focused initially. The record stays visible while deleting and on failure. A validated success removes it and displays a toast. An open confirmation cannot silently adopt a newer record version after Refresh.

Deletion is permanent and applies only to records never used in delivery planning or history. For previously used participants, crews or templates, disable the record using its existing edit form instead. Remove a participant from their default crew before deleting them. Deleting an unused crew removes its roster links, preserving participant profiles. Existing visits and snapshots are never rewritten by these operations. Blockers are rechecked by the backend; a dialog warning is not an authorization check.

The existing authenticated HTTP client sends `DELETE /participants/:id`, `/crews/:id` or `/templates/:id` with `{version}` and validates `{id, deleted: true}` before changing local state. A pending directory read is cancelled after successful deletion, preventing an old response from reintroducing a deleted row. Known deletion conflicts are translated into English, Italian, Russian and Uzbek.

Local checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Focused regressions: `node --import tsx --test test/directory-crud.test.ts`. Start the built Backoffice with `npm start` on port 3000 and the existing Docker API on port 3001.

## Local acceptance — 2026-11-10

Frontend typecheck, typed lint and production build passed. The full frontend suite passed 146 tests; the final focused CRUD run passed 8 tests including the subsequently added four-language conflict assertions. Backend typecheck, typed lint, Docker build and 15 real PostgreSQL integration tests passed. Those tests exercise successful create/read/update/delete, auth/CSRF, stale versions, default-roster and historical references, session revocation and concurrent delete versus update/assignment in isolated PostgreSQL 18.6 schemas.

The main Docker backend was rebuilt and restarted without migrations. Live authenticated reads by ID passed for all three directories, with no-store responses, anonymous denial, operator DELETE denial and DELETE CORS preflight. The production Backoffice was rebuilt and restarted at port 3000.

Chrome verified View, existing New/Edit forms and named Delete confirmations/Cancel for all three record types. Cancel receives initial focus. Read views and confirmations were inspected in light/dark; the 320 px confirmation had document width 320 and dialog client/scroll widths both 293. The viewport and original Light theme were restored. No permanent deletion was submitted in the main browser. The user's original visit draft was preserved in its existing tab.

Before/after database digests matched for 22 deliveries, 20 participants, 6 crews, 15 roster links, 6 task templates and 5 route drafts. No demo business data changed. Evidence: [directory actions](screenshots/directory-crud.png).

## Verification — 2026-11-10

Project typecheck, full typed lint, the 146-test frontend suite and production build passed. After adding translated conflict handling, the focused CRUD suite passed 8/8 (including EN/IT/RU/UZ × roster/history conflicts), scoped typed lint passed, and production build passed again. Coverage includes all three delete payloads and versions, cancellation, pending/success state, actionable 409 retention, stale confirmation blocking, operator detail permissions, and obsolete reads after deletion. Browser and main-runtime verification are recorded separately below by the runtime owner.
