# Published route lifecycle — stages 07–09

Implementation date: 2026-11-11. This extends [the publication contract](route-publication.md) and [publication implementation](route-publication-implementation.md). The shared demo publication gate remains disabled by default; isolated acceptance fixtures explicitly enable it.

## State and ownership

`published → in_progress → returning → returned → closed` is the normal path. `published → cancelled` is available only with explicit not-departed and not-loaded attestations. Physical return may also be recorded directly from `in_progress`, including when reports are missing. An operator can abort a published/in-progress route into `returning`; this preserves resource custody until actual return instead of claiming that a loaded trip was cancelled.

- The route owns crew, actual participant and vehicle reservations for the full trip. Finishing or skipping the last stop does not release the trip.
- Departure rechecks the complete journey using the actual departure time, current work, windows, working intervals, skills and resource availability, including return.
- A previous trip without recorded return blocks immediate resource reuse. After physical return, the maximum applicable transfer buffer still applies to both route departure and standalone visit start.
- Actual return replaces the raw reservation end. It must follow publication/departure and cannot be in the future. Missing reports, incomplete reconciliation or a future booking never prevent recording the physical fact.
- Route closure does not complete a Picking, fabricate quantities, release damage holds, create orders or write to Odoo.

The route responsible participant is explicitly derived from the first stop's reviewed responsible participant. That person and an assigned participant-driver may depart or record return. Current assigned participants may read the route. Dispatchers can perform operational actions with a reason. Removed participants immediately lose route access.

## Crew (07)

`GET /crew/routes` and `GET /crew/routes/:id` expose the current ordered stops, reviewed work/timing, destination and saved entrance, resource snapshots, responsible participant, current customer confirmation, and server-owned action capabilities. Existing standalone visits remain available separately; routed visits have a route link and a start blocker code.

Crew commands:

- `POST /crew/routes/:id/depart`: `{version, requestId}`. The next stop must be booked, reviewed and customer-confirmed. Later stops need their own confirmation before starting.
- `POST /crew/routes/:id/returning`: `{version, requestId}`. All stops must be reported or explicitly skipped by a dispatcher.
- `POST /crew/routes/:id/return`: `{version, requestId, actualReturnedAt, note?}`. Physical return can be recorded even with outstanding reports.

Starting a later stop before the preceding stop finishes or is skipped is rejected by the same domain start guard used by the existing visit API. Route commands reauthenticate the live Crew session after waiting for transaction locks, and check current assignment and responsibility before both mutation and idempotent replay.

## Reviewed changes and cancellation (08)

`POST /routes/:id/amend-review` accepts the current route version, reason, both attestations, a complete proposed route plan, exact per-appointment responsible participant selection and an external driver phone when applicable. It returns a fingerprint, estimated complete-trip feasibility and the appointments whose confirmation will be reset.

`POST /routes/:id/amend` adds `requestId`, that fingerprint and `acknowledgeEstimates:true`. It is atomic. Changed source versions, work or dependencies require a new review. The current implementation preserves the exact appointment set and work quantities; it supports order, duration, departure, customer windows, crew, actual people, vehicle, driver and responsible participant changes. New stop insertion and cargo transfer between departed vehicles are outside this amendment command.

Task/checklist IDs and snapshots are retained; every proposed participant is checked against saved task requirements. Appointment intervals follow the reviewed timeline. Changed appointment intervals or customer window semantics reset customer confirmation. Active transport allocations are retired with history and replaced; they are not silently overwritten.

`POST /routes/:id/cancel` accepts a reason, both attestations, and explicit `cancelAttachedAppointmentIds`. Created visits are cancelled. Attached visits are detached by default and retain their current work, staffing and confirmations, including facts added after publication. Only explicitly selected attached visits are cancelled.

All own child ledgers switch ownership together before standalone restoration, avoiding transient self-conflicts. Original attached transport is restored through a new allocation if an amendment retired it. The old retirement remains historical. If the original transport interval cannot cover the current appointment, or resources are no longer available, cancellation fails atomically with an explicit review requirement; it never overwrites the current visit with its old aggregate.

After departure, dispatchers use `POST /routes/:id/stops/:appointmentId/skip` for an unstarted, unreported stop, or `POST /routes/:id/abort` with a reason. Skipping releases only that stop's work; it preserves signed reports on other stops and the route reservation through actual return.

## Reconciliation and warehouse receipt (09)

`GET /routes/:id/operations` combines the current committed schedule with live visit facts. Product lines are identified by delivery, appointment and source-line ID; SKU is never used as identity. Quantities distinguish planned work, delivered/installed/collected facts, global remaining work and quantities currently available for planning. Missing reports and packaging data are explicitly unknown.

If a source line disappears after publication, its historical work remains readable. `remainingBasis:visit_snapshot_source_missing` identifies conservative original-visit remainder rather than current delivery totals; availability is zero and source review blocks normal closure.

`POST /routes/:id/reconcile` records every exact route line once, a dispatcher owner, note, one next action for each remaining operation, and applicable cargo declarations. Owners come from `GET /routes/reconciliation-owners`. Actions include repeat planning, installation, waiting for replacement/customer, manual review, and an already-planned follow-up. A follow-up must reserve the same source-line operation on another live appointment of the same delivery. Existing work holds and quantity reservation rules still apply.

Cargo is declared separately as collection or undelivered goods, with location, quantity (or explicit unknown), and note. Planning a quantity does not prove it was loaded. A dispatcher can document that undelivered goods remained at the warehouse. Fully handed-over or installation-only lines need no invented cargo. Unaccounted quantities remain closure blockers.

`POST /routes/:id/warehouse-receipts` records an independent, bounded receipt for exact visit/source-line/cargo-kind tuples. Collected quantity is not warehouse receipt. Receipts cannot exceed reported collection or explicitly verified undelivered cargo awaiting receipt. Replaying a request does not double quantities. Receipt and report discrepancies remain visible.

`POST /routes/:id/close` requires actual return and exact reconciliation with owners and next actions. Every still-booked, unstarted stop must first be explicitly skipped, including when closing with an exception, so work cannot become stranded on a closed route. Normal closure also requires complete reports and accounted cargo. An explicit `exceptionReason` can record administrative closure with outstanding started-visit report/cargo problems; it never invents completion or warehouse stock. A route closed with an exception permits later append-only reconciliation and warehouse receipt as missing facts arrive. The original closure, exception and prior revisions remain preserved. Normal closed routes cannot rewrite reconciliation.

## Transactions, history and API contract

All state commands return HTTP 200 with the authoritative `RouteOperationsSchema`. Expected versions, request IDs, strict Zod input parsing, existing role/Origin guards and bounded schemas are enforced server-side.

Each mutation obtains the existing scheduling advisory lock, the publication row lock, and sorted delivery row locks before reading state. It validates live authorization, checks the request receipt, applies changes, updates dirty delivery aggregates, saves the next route revision and command receipt, and writes delivery audit entries in one transaction. A late failure rolls back all of them. Request-ID reuse with different input is rejected. Authorized same-input replay returns the current route without repeating effects.

`GET /routes/:id/revisions/:version` exposes immutable previous schedule/runtime versions. `GET /routes/:id/publication` is the current publication snapshot; the original is revision 1. The Routes list uses the current published name and departure after amendments while preserving the original saved draft.

Migration `RouteLifecycle1793701200000` adds runtime JSON, command receipts and immutable revisions, and makes the existing route stop sequence uniqueness constraint deferrable for atomic reordering. It is additive and requires the isolated PostgreSQL configuration/transaction checks. There is no destructive automatic down migration.

## Verification and limits

The real PostgreSQL HTTP regression suite is `test/route-lifecycle.test.ts`, with owned-schema fixtures in `test/support/route-lifecycle-fixture.ts`. It covers protected Crew access/departure, exact stop order, idempotent effects, cancellation restoration and rollback, amendments/version history, participant access removal, cancellation/departure races, partial delivery and installation remainder, separate collection receipt, missing-report return, turnaround buffers, and dispatcher skip preserving signed history. Additional queued-session/reconciliation regressions are maintained there.

Run the existing isolated Docker test service with this test file, then project `npm run typecheck`, `npm run lint` and `npm run build`. Browser acceptance uses the dedicated test API and frontend ports documented in the publication runbook; it must not mutate the shared main database. Test execution outcomes and final browser evidence are recorded in the current development handoff, not inferred from these commands.

This is still a local pilot: estimates are not road travel calculations, packaging/loading is not inferred, normal amendment uses one fixed trip composition, and a split/unknown custody situation requires explicit dispatcher review. There is no new infrastructure, paid maps call, automated cargo transfer, warehouse accounting or real-client database write.

### Recorded checks · 11 November 2026

Final full backend run: **263/263 tests passed**, no skips, on the isolated PostgreSQL test database (`.local/route-lifecycle-final-full.log`). The focused lifecycle suite passed **17/17**, including session revocation while waiting for locks, idempotent authorization, restoration of original transport after a vehicle amendment, late reports following exception closure, and mandatory explicit skipping of unstarted work. Final typecheck, full typed lint, build and OpenAPI generation passed. Docker runtime and tools image builds passed. Earlier broad-run failures were outdated strict test decoders for the new route fields; the independent Crew privacy assertions were retained when those decoders were updated.

### Repeatable isolated demonstration

The lifecycle harness publishes three synthetic routes in a new owned schema of `delivery_backoffice_test`: create, attach, and collection. Main application records are not seeded by this harness. The ignored `.local/lifecycle-browser-demo/connection.json` contains its exact identifiers and private demo credentials. Never copy it into shared documentation.

```powershell
docker compose --profile tools run --rm --no-deps --name delivery-lifecycle-browser --publish 127.0.0.1:3011:3001 -e BACKOFFICE_TEST=1 -e ROUTE_PUBLICATION_ENABLED=true -e FRONTEND_ORIGIN=http://127.0.0.1:3010 -e CREW_FRONTEND_ORIGIN=http://127.0.0.1:3012 -v "${PWD}/src:/app/src:ro" -v "${PWD}/scripts:/app/scripts:ro" -v "${PWD}/local:/app/local:ro" -v "${PWD}/.local/lifecycle-browser-demo:/app/.local/lifecycle-browser-demo" tests npx --no-install tsx scripts/demo-route-lifecycle.ts
```

To reload this specific test API, stop only `delivery-lifecycle-browser` and repeat that command with `--resume` after the script name. Resume validates the saved owned schema and does not regenerate users, reset routes, or replace credentials. Omitting the flag creates a fresh namespace while preserving previous demonstrations.

`scripts/demo-route-lifecycle-report.ts`, with `BACKOFFICE_TEST=1` on the host, prepares only the collection route through authenticated operator/Crew HTTP at port 3011. It records two completed visits with clearly synthetic per-line photos and signature drawings; it leaves actual return and warehouse receipt for independent interface verification. This is teaching evidence, not real delivery evidence. Use separate frontend copies on 3010 and 3012 with their explicitly allowed test API origins; the main 3000/3002 apps continue to use 3001.

### Main local Docker rollout · 11 November 2026

The existing local main API on **3001** now runs stages 06–09. The ignored local `.env` has an appended `ROUTE_PUBLICATION_ENABLED=true`; the committed Compose/config default remains false. Main frontend origins stay **3000** and **3002**. Only the task-owned backend/importer containers were recreated. PostgreSQL and its named volumes were preserved; no cloud deployment, reseed or reset was performed.

Before rollout, the main database had 11 migrations. `RoutePublication1793701100000` and `RouteLifecycle1793701200000` were applied together using `docker compose run --rm --no-deps migrate`. The main database now has 13 migrations, the five new route tables initially contain zero rows, and the sequence uniqueness constraint is deferrable. Existing saved drafts were not published automatically.

Verified private recovery backup: `.local/backups/docker_20261111T163932Z_56710465/docker-backup-manifest.json`. It contains the three database dumps, globals, the complete application-data archive and seven connection secrets. An additional verified copy preserves the seven current isolated-browser demo files, including its private manifest, plus the pre-change local environment. These files contain private recovery information and must not be committed or shared. The earlier incomplete `docker_20261111T163620Z_849fd28d` directory has no valid manifest and is not a recovery backup.

All writers, including the separate test API, were stopped for the joint backup. The existing snapshot helper was corrected to join multi-line PostgreSQL JSON aggregates before parsing; the actual multi-schema backup then completed and verified its before/after snapshots and file SHA256 values.

Before enabling/restarting the API, verification proved all **20 pre-existing application tables** unchanged (excluding the expected migration ledger update), fake Odoo unchanged, all application-data bytes matching the backup archive, and all seven secrets unchanged. Odoo access remains read-only: no INSERT/UPDATE/DELETE privileges or public-schema CREATE privilege. The verification record is stored beside the private backup.

After restart, API health returned `ok` for `delivery_backoffice`, Docker backend/database health checks passed, and the existing counts remained **27 deliveries, 36 appointments, 21 participants, 7 crews, 19 file records, 6 drafts, 0 published routes**. The importer was restarted normally. The isolated API is independently resumable with the command above; its schema and teaching evidence were preserved.
