# Shared planning references

Shared participant availability, departure/return locations and work-time standards are implemented after tasks 14, 16 and 17. The customer-schema development stand was upgraded on 2026-11-13. This document records the implemented behavior, checks and startup commands; actual company scheduling data and confirmed standards still need to be entered.

## Participant availability (task 22)

Dated entries belong to a person, independently of their regular crew: shift, break or absence, offset-bearing start/end instants, Europe/Rome display, source reference, note, author and immutable change history. Archive/restore preserves history. Normal Backoffice operators may maintain these scheduling facts.

Routes explicitly choose manual availability or the shared calendar. Legacy routes retain manual mode. Shared mode resolves fresh entries for the whole departure-to-return interval and fingerprints the relevant entry IDs and revisions, not the query time. Missing shifts remain unknown. Calendar changes require a fresh review before publication/departure; saved published revisions remain frozen. Already-started reports and actual return recording must remain available.

The existing feasibility rule treats a break overlapping the whole trip as a conflict. This first calendar implementation does not automatically insert lunch stops or optimise pauses into the ETA schedule.

Backend implementation verified on 2026-11-13:

- `GET /api/planning/calendar?startsAt=...&endsAt=...` lists overlapping entries. Both timestamps require an offset; the interval is at most 366 days. Optional filters are `personId`, `kind=all|shift|break|absence`, and `status=active|archived|all`. More than 5,000 matches requires a narrower filter instead of silently truncating the calendar.
- `POST /api/planning/calendar` requires `requestId`, participant, kind, offset timestamps, `timeZone: "Europe/Rome"`, `sourceReference`, `note` and a change `reason`. Shifts can span midnight and last at most 48 hours; breaks at most 24 hours; absences at most 366 days. There are no generated recurring shifts or assumed working hours.
- `GET /api/planning/calendar/:id` reads the current entry and its immutable history in one repeatable-read transaction. `PATCH` uses the same editable fields plus `version` and `archived`. The participant identity is fixed; archive and create another entry to move scheduling facts to someone else. History remains available after archive/restore, up to 1,000 revisions per entry. A participant with calendar history can be disabled but cannot be hard-deleted.
- A route opts in with `planning.availabilityMode: "shared_calendar"`; omitted or `manual` preserves the earlier behavior. Shared mode ignores manual participant intervals while retaining them in the draft, uses fresh entries through the calculated return, and merges adjacent shifts for coverage checks. Reordering suggestions re-evaluate the shared entries against each candidate return time.
- Only relevant entry identities, versions, participants, kinds and intervals enter route snapshots. Private calendar notes and source references are not exposed in Crew route snapshots. A changed relevant revision requires a new publication review or amendment before departure. Departure also checks availability against the actual departure time. Archived shifts do not prevent reporting or recording physical return for a route that already departed.

Focused verification: `test/planning-calendar.test.ts` passed 4/4 tests against isolated PostgreSQL, including normal authorization/Origin guards, actor-bound replay, versions, immutable archive/restore history, overnight/DST instants, person/date isolation, adjacent shifts, return travel, breaks, stale publication/departure, amendment, preserved route revisions and Crew reporting/return after a calendar edit. Backend typecheck and typed lint passed for the changed paths. The later repeatable-read detail wrapper and long-return query bound are included in the final combined regression run; this checkpoint does not claim the customer-schema runtime or browser was already upgraded.

## Departure and return locations (task 24)

Implemented `GET/POST /api/planning/locations` and `GET/PATCH /api/planning/locations/:id` for normal Backoffice operators. Records contain the name, structured address, address point and optional unloading entrance, source/verification, availability, version and actor history. Writes require a reason and actor-bound idempotent request ID; updates also require the current version. Disable records instead of deleting their history. The catalogue is bounded to 1000 records and detail history to 1000 revisions; exceeding a read limit fails explicitly rather than returning a partial catalogue. Detail reads use one repeatable snapshot.

Migration `1793701600000` preserves the four existing demonstration IDs, names and exact coordinates once. Re-running the migration runner does not overwrite operator edits. Public reference buildings remain explicitly DEMO points and must not be presented as company warehouses. Enter and confirm actual warehouse addresses and unloading points through the catalogue.

Departure and return are independent selections. Drafts use current catalogue data; published routes retain names, coordinates and provenance snapshots. Changing a point invalidates related manual travel contexts and publication reviews. Before departure, a changed/unavailable location requires normal route review/amendment. Historical display and already-started report/return actions do not rewrite their endpoints from the current catalogue.

Demonstration points use the existing estimate acknowledgement. A non-demo unverified point can be saved as a draft, but requires operator confirmation before publication. No paid map API or external database write is involved.

`test/planning-locations-http.test.ts` passed 5/5 checks on isolated PostgreSQL: HTTP authorization/Origin, actor-bound retries, concurrency/history, migration preservation, independent start/end and unloading points, unverified/disabled/missing-point feasibility, stale manual/publication reviews, frozen historical revisions, explicit amendment and successful Crew report/actual return after a later location change. See [planning-locations.md](planning-locations.md). Combined application checks and the target runtime upgrade are recorded separately.

## Work-time standards (task 20 reference catalogue)

Templates are selected explicitly for an exact product line, never attached automatically by SKU. Fields: name, service, unit, optional category, delivery/installation/collection minutes per unit, time basis, assumptions/exclusions/examples, source reference, draft/confirmed status, availability, version and author/history.

The time basis distinguishes elapsed team minutes from person-minutes and unspecified information. Only confirmed elapsed-team standards with matching service and unit can be applied to a line. No automatic division by crew size is permitted. Applying a template copies its rates and version/source provenance through the existing work-time rules; it does not overwrite other lines or recorded report snapshots. Existing local rates remain until explicit application. A later manual rate edit becomes a local choice again.

Actual company standards and representative examples still need Francesca's input. Do not seed fabricated confirmed standards. Advanced fixed overhead, parallel-work modelling and automatic category recommendations belong to the later estimation work (task 21), not to this catalogue's completion claim.

`GET/POST /api/planning/time-standards`, `GET/PATCH /api/planning/time-standards/:id` use normal operator/admin authorization and Origin checks. Create/update responses contain the saved record; detail includes current record and immutable before/after history. Catalogue size is bounded at 1000 records, displayed history at 1000 revisions; exceeding a bound produces an explicit error. A disabled standard can be restored with a versioned update; there is no hard delete.

`POST /api/deliveries/:id/work-times/standard` accepts delivery `version`, stable `requestId`, exact `sourceLineId`, `standardId`, reviewed `standardVersion` and `reason`. It uses the existing line work-time domain rules and stores the copied `timeStandard` snapshot in the line and `work_times.standard_applied` History. Units must match exactly after trimming; no packaging conversion is inferred. Confirmed zero/unknown rates are not interchangeable: applicable rates must be integer minutes from 1 to 1440, and operations outside the service remain null.

Focused isolated PostgreSQL verification: 4/4 tests covering authorization/Origin, optimistic concurrency and actor-bound retries, exact-line isolation for identical SKUs, preserved catalogue versions, Nearby/Routes estimates, manual override provenance, unusable standards and in-progress work locks. Combined regression also checks case-normalized request replay and preservation of standard provenance through repeated source imports. The final runtime/browser checkpoint follows below.

## Persistence and verification

A small shared planning-catalogue receipt helper provides actor-bound idempotent commands, without a generic CRUD framework. Separate business schemas/services retain their own validation. All writes share the existing planning advisory lock so catalogue edits cannot race publication checks. Normal auth and Origin guards, optimistic versions and mandatory explanations remain active. Migrations and behavior were tested against isolated PostgreSQL before the customer-schema development runtime was upgraded.

Applied migration sequence after dispatcher `1793701400000`: catalogue command receipts `1793701500000`, locations `1793701600000`, participant calendar `1793701700000`, time standards `1793701800000`. This is an implementation coordination sequence, not a new task numbering scheme.

## Final verification and runtime — 2026-11-13

- Backend: the full test suite passed **374/374** against isolated PostgreSQL. Strict typecheck, typed lint and build passed.
- Backoffice frontend: the full suite passed **254/254**; the final focused checks passed **8/8** after the last changes. Strict typecheck, typed lint and build passed.
- Crew frontend: **44/44** tests, strict typecheck and typed lint passed.

The existing `delivery-odoo-customerdev` Docker stand now has **19 applied migrations**. The JSON fingerprint of all **790 deliveries** was unchanged across the upgrade. No Odoo data was written and no external reimport was performed during this implementation checkpoint. No new demo Pickings or synthetic completed-work declarations were added to this stand. Its catalogue contains the four preserved DEMO locations; real shifts, company locations and confirmed time standards still require actual operational data.

Before migration, the application database was backed up to `.local/odoo-integration/delivery-odoo-customerdev/backups/pre-planning-20261113-0b05cc49/application.dump`, alongside the delivery fingerprint and a manifest. The dump was checked with `pg_restore --list`. The stand had **0 file records**. This backup check is not a new joint database-and-files recovery drill; the earlier isolated recovery exercise remains documented separately in [recovery.md](recovery.md).

Browser verification on the upgraded stand confirmed the catalogue pages and these state-preservation flows: an unsaved location draft survives Refresh; the dispatcher queue shows 789 address cases with 10 rows per page; page 2 and filters survive Refresh; opening a delivery and returning preserves the selected case's unsaved next action and note; refreshing the case dialog also preserves its notes. The prior-work block and source-review interface were visible. These browser checks made no data writes.

Current local URLs:

- Backoffice: `http://127.0.0.1:3030`
- Backend API: `http://127.0.0.1:3031/api`
- Health: `http://127.0.0.1:3031/api/health`

From `backoffice-backend`, the existing startup script rebuilds/starts the backend and database with the private geocoding mount. It does not start an import polling worker:

```powershell
./scripts/docker-odoo-start.ps1 -ProjectName delivery-odoo-customerdev -GeocodingSettingsFile .local/maps/geoapify.json
```

The frontend runs on the host from the staged build under `backoffice-frontend/.local/odoo-integration/frontend-planning-20261113`. To restart that existing build, run from that directory:

```powershell
node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3030
```

When rebuilding the staged frontend from current source, set the API URL before the build; Next.js embeds this public value at build time:

```powershell
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3031/api'
npm run build
```

Refresh the staged source from the frontend project before rebuilding; the staging directory is a runtime copy, not the authoritative source. Stop only its verified process before restarting on the occupied port. Existing teaching, restored and other local stands remain independent.
