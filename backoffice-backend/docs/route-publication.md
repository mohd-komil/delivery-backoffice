# Route publication contract — task 05

Prepared 11 November 2026. Canonical product rules and acceptance cases: [Notion task 05](https://app.notion.com/p/4154433fac0f81f59d4fe20daa6cb5d3). Implementation belongs to [task 06](https://app.notion.com/p/4154433fac0f811a802cc797ceecc839); Crew execution, amendments and closure belong to tasks 07–09.

**Historical task-05 contract:** the two policy decisions were confirmed by Komil on 11 November 2026. The baseline descriptions below record the state before implementation. Task 06 now implements the gated publication API and review flow; see [implementation, rollout and verification](route-publication-implementation.md). Departure, cancellation, actual-return controls and normal rollout remain tasks 07–09.

## Decisions and boundaries

Confirmed existing requirements: preserve exact order/source-line identity and separate delivery, installation and collection quantities; reserve only available remaining work; damage holds require an operator's explicit readiness decision with a note; publication does not imply customer confirmation or Picking closure; use the same authorization and immutable signed History; estimates remain visibly approximate without paid maps.

Proposed first implementation: one crew, fixed actual participants, one vehicle and one driver throughout a route, up to the existing limit of 30 distinct deliveries. Existing standalone multi-crew visits remain supported and are not migrated automatically. A route responsible participant can default the responsible person for each stop; every stop must have an explicitly reviewed responsible participant from its actual assigned people.

Product decisions explicitly confirmed by Komil in this chat on 11 November:

1. Publication may reserve the route while some customers have not confirmed, with an explicit waiting status. Each visit's Start still requires its own confirmation. Customer-window semantics must be known regardless.
2. An executed route releases people/vehicle after an explicit actual-return event, not the estimated return timestamp. Operational availability and warehouse reconciliation remain separate.

These are Komil's decisions, not a claim of Gianluca's acceptance. Other choices below are documented engineering defaults for the initial implementation. In particular, departure requires the next planned stop to be ready and customer-confirmed; later pending stops do not prevent publication or departure, but their Start stays blocked. Changing the next stop is an explicit dispatcher action, not an automatic reorder.

## Existing implementation and the reuse boundary

| Existing owner | Reuse / required integration |
| --- | --- |
| `src/routing/contracts.ts`, `service.ts`, `feasibility.ts` | Draft version, exact appointment selection, reviewed work fingerprints, windows, timeline and full-trip feasibility. Current unbound preview dynamically reads all available work; publication must instead persist explicitly selected work. |
| `src/operations/store.ts` | Shared scheduling lock `7041001`, validated persistence, optimistic delivery versions and audit. `mutate()` starts its own transaction: do not call it separately for each stop. |
| `src/domain/rules.ts` | Reuse `planVisitWork`, `lineServiceStatuses`, reviewed-scope, stock/readiness, Start and report rules. Do not reproduce quantities or skills in a second publication rule engine. |
| `src/operations/operations.ts` | Reuse booking, exact actual staffing, task/checklist snapshots, responsibility, reschedule and confirmation invalidation through transaction-scoped operations. |
| `src/operations/vehicles.ts` | Both service and transport ledgers currently belong to an appointment. Full-route vehicle allocations copied onto every stop would conflict with one another. Route ownership must be recognized before publishing. |
| `src/integration/importer.ts` | Source import shares the scheduling lock. Its material changes must invalidate the reviewed publication input. |
| `src/crew/visits.ts` | Preserve standalone visits, actual assignment authorization and existing history/file access. Only route-linked visits gain route-specific lifecycle checks. |

An existing preview being feasible proves neither publication atomicity nor a resource reservation. Publication is not present in the current routing controller or database schema.

## Publication review and exact stop selection

Before Publish, the dispatcher sees created versus linked visits, source Picking/order/line, operation quantities, tasks, actual people, stop responsible, vehicle/driver, known customer windows, confirmation states, departure, ETA, on-site intervals, return and reservation buffer. The estimate acknowledgement is tied to that exact review. It never waives a conflict or missing data.

Each stop explicitly uses one of these modes:

- **Create**: exact delivery/source-line IDs and quantities, selected task templates, actual staffing and responsible participant; optional existing return-request ID. Revalidate current available quantity, but do not expand it automatically if new work becomes available.
- **Attach**: an exact still-booked, unstarted appointment ID, with no result and no active membership in another route. Preserve its ID, work scope, task/checklist snapshots, compatible staffing, responsibility and history. Never select the first visit merely because its delivery matches.

Linking must not silently change booked times, work or actual staffing. A computed service interval is not a new customer agreement. The review must show a mismatch and require an explicit reschedule/scope/staffing action; v1 can require correcting the standalone appointment before publishing. Recompute and review afterward. Any interval or scope change uses existing rules and clears customer confirmation. If interval, scope and customer agreement are unchanged, linking itself preserves confirmation.

Persist the agreed customer window separately from calculated ETA/service start/service end. The selected `arrival` or `work_end` meaning must remain explicit. Missing meaning is not unrestricted. A service interval must fit the linked booked interval; do not silently shorten an existing resource reservation when adopting it into a route. If its reserved interval falls outside the reviewed full-trip reservation, require an explicit reviewed correction before publication.

The first release does not attach in-progress/completed/cancelled visits, select two visits for the same delivery in one route, merge identical SKUs, add work during publication, or replace a customer's accepted scope implicitly.

## Server command and one atomic transaction

Proposed command: authenticated `POST /api/routes/:id/publish` containing a request ID, expected saved draft version, accepted publication-review fingerprint, exact create/attach stop selections, and estimate acknowledgement. This endpoint does not exist yet. The fingerprint for publication must include the new explicit scope/task/responsibility fields, not just today's draft-preview fields.

Server sequence:

1. Validate the runtime body, authenticated admin/operator role and existing Origin policy. Recheck authorization before returning an idempotent receipt.
2. Enter one database transaction and acquire the existing shared scheduling lock. Read the route and involved deliveries using this transaction's manager; use deterministic ID order for any additional locks.
3. Check the publication receipt. Same successful request and canonical command returns the original publication and stop IDs; different content for that request ID conflicts. Retry must work after the route changes lifecycle state; it must not republish or reset that state.
4. Verify draft version, publication state and exact appointment ownership. Read current work, source, entrance, tasks, skills, people, vehicle/driver availability, windows, shifts and breaks. Recalculate the full schedule and review fingerprint. A changed dependency requires review even when the draft version is unchanged.
5. Require known travel/work/return, exact remaining work, required skills for every selected participant, stock/readiness and complete required declarations. Participant driver is one selected person; external driver needs name, contact and declared availability. An external name is not a globally unique resource ID: report that conflict coverage is declared, not independently proven.
6. Validate all stops and all resource conflicts before committing. Reuse transaction-scoped domain operations; never issue nested HTTP requests or independently committed per-stop commands.
7. Atomically persist the published revision and reviewed snapshot, stop-to-appointment membership, any new visits and work snapshots, compatible assignments and responsibilities, route-owned resource reservation, command receipt and audit records. Membership records whether the appointment was created or attached and retains its pre-adoption resource ownership, intervals and relevant snapshots for deterministic detach/restoration. Increment each affected delivery version once per transaction. Return the saved result only after commit.

Any failure rolls back all participating writes, including audit and receipts. No emails, paid maps calls, Odoo writes or other external side effects occur inside this operation. Canonical request hashing must treat semantically unordered selections consistently while preserving stop order and exact quantities.

## Resource and quantity ownership

- A work quantity is reserved by the exact booked/in-progress visit scope. Route membership must not create a second quantity reservation.
- An appointment belongs to at most one active route. Enforce that in storage as well as in the server command; keep historical memberships after detach/cancellation.
- One route owns each unique crew/person/vehicle/participant-driver reservation across outbound travel, waiting, service, inter-stop travel and return. A person who also drives has one resource identity. Store the raw trip interval and reviewed transfer buffer separately. For a shared resource the gap between two routes must be at least the larger of their buffers; do not pad an already padded reservation again. Treat a standalone reservation's unspecified buffer as zero, preserving the existing route-versus-standalone check. This is an explicit v1 planning default.
- Linked child appointments may coexist with their route reservation only through exact membership. Do not exclude all visits on a delivery, all visits of a crew, or arbitrary IDs supplied by a client.
- All reservation writers and readers must recognize the owner: standalone booking/assignment/staffing/transport, route preview and publication, participant/vehicle availability and calendars, cancellation/reschedule and Crew transitions. Do not add a second ledger checked only by Publish.
- Finishing or cancelling a single stop must not release the remaining trip's resource reservation. Work quantity release and resource release are different operations.
- A resource change after departure/loading must not imply a physical cargo transfer. Until transfer is supported, require a reviewed abort/return or manual exception process with retained custody/history.

Future bookings can be planned after the estimated return and required buffer, but show their dependency on that return. A route still in progress cannot become available merely because the clock passed its estimate. An overdue route creates an operational conflict; block departure/start of the next affected assignment until return or a reviewed resource substitution. Actual return ends the in-transit hold; an explicitly configured turnaround buffer still applies from actual return before the next departure. Zero buffer permits immediate reuse. Do not erase the later booking or pretend a timeless reservation cancels all future scheduling. Record factual late return even if it exposes a conflict; a collision must not prevent recording reality.

## Proposed lifecycle and mutation rules

| State / event | Result and guard |
| --- | --- |
| Draft → Publish | Immutable published revision, exact linked visits and atomic reservation. Draft save alone stays side-effect free. |
| Published → Depart route | Explicit action by assigned route responsible/participant driver, or operator with reason. No automatic departure from the planned timestamp. Record actual departure before first on-site work. Check current resources, next-stop readiness and its customer confirmation; pending later stops remain blocked individually. |
| In progress → Finish one stop | Existing Crew report rules, photos/signatures/customer-absent exception. Partial/failed outcomes do not force the route to stop. Exact remaining work stays with its source delivery. |
| In progress → Returning | Explicit end of stops. Normally all stops have a terminal report or dispatcher-authorized skip/cancel with reason. If a report is missing or an emergency ends the trip, the operator records the exception; capture physical return without inventing a zero-quantity report, terminal visit or client signature. |
| Returning → Returned / review | Record actual return separately from warehouse acceptance, even with unresolved reports. End in-transit resource holds; apply the explicit turnaround buffer. Unresolved cargo stays visibly awaiting receipt, not automatically stock-ready. |
| Returned / review → Closed | Require a terminal outcome for each stop, or an explicitly documented reconciliation exception without inventing performed work. Dispatcher records reconciliation and next action/owner for unresolved work/cargo. Missing required report/evidence blocks normal closure. Route closure never closes a Picking automatically. |
| Published → Cancelled | Allowed before departure and loading. Until loading tracking exists, require the operator to explicitly confirm that the route has not departed and cargo is not loaded; missing data is not proof of an empty van. Reason required. Route-created visits cancel and their unused work releases; attached existing visits are restored/detached by default, retaining their standalone booking/confirmation. Cancel those visits only by explicit selection. A restoration conflict rolls back the whole cancellation. |
| After departure → Abort / returning | A reasoned operational workflow, not ordinary unbooking. Preserve completed facts, active work and cargo; do not silently free the vehicle/driver or rewrite signed reports. |

Before departure, a revision may change future stops/resources only after fresh review and atomic replacement of reservations. During a trip, v1 forbids ordinary route edits: the dispatcher handles skipped stops/abort/return through explicit actions. Later amendment support can change only unstarted work after revalidation; it must not rewrite the driven segment or signed reports. A source change after publication preserves the old snapshot and raises review, and existing Start validation still applies.

Route-linked standalone edit/cancel endpoints must require the route workflow. Guard all paths, including person/crew/vehicle disablement and skill/task changes; changes that invalidate a published route must produce a visible conflict/review state, never a hidden discrepancy. The precise command reuse/extraction is implementation work, not permission to refactor unrelated modules.

## Failure contract

Use the existing safe HTTP error shape with a stable code and affected stop/resource where authorized. Suggested codes: `ROUTE_DRAFT_CHANGED`, `ROUTE_PREVIEW_STALE`, `ROUTE_ALREADY_PUBLISHED`, `APPOINTMENT_UNAVAILABLE`, `APPOINTMENT_ALREADY_ROUTED`, `APPOINTMENT_SCHEDULE_MISMATCH`, `WORK_SCOPE_REVIEW_REQUIRED`, `WORK_ALREADY_RESERVED`, `ROUTE_RESOURCES_CONFLICT`, `ROUTE_FEASIBILITY_INCOMPLETE`, `ROUTE_ESTIMATE_ACK_REQUIRED`, `ROUTE_CHANGE_REQUIRED` and request-ID content conflict. Exact status mapping is to be locked by HTTP tests in task 06; do not leak SQL, credentials or unauthorized assignment details.

## Required acceptance scenarios (future publication tests)

| ID | Given / action | Observable result |
| --- | --- | --- |
| P01 | Two new stops, two orders with identical SKU | Independent source-line operation scopes; one full-trip resource owner; no merging. |
| P02 | One explicitly attached visit and one new stop | Attached appointment ID/history/confirmation retained when unchanged; exactly one new visit. |
| P03 | Two eligible booked visits for one delivery | Exact selection required; no implicit first/most recent choice. |
| P04 | Last stop conflicts | No published revision, earlier visit, quantity/resource reservation, audit or success receipt survives. |
| P05 | Same successful request after lost response | Same publication/visit IDs, no repeated effects. Different content for the ID conflicts. |
| P06 | Two dispatchers publish conflicting routes | Only one reservation succeeds; loser receives a conflict and has no partial state. |
| P07 | Publish races individual booking, staffing, vehicle allocation or source import | Shared serialization protects quantities and the entire trip. Test both possible winning orders. |
| P08 | Draft unchanged but scope/entrance/skill/availability changed | Reviewed fingerprint rejected; no newly available quantity added automatically. |
| P09 | Another booking overlaps only outbound, waiting, between stops or return | Publication conflicts; exact own child visits alone are exempt. |
| P10 | Missing window/shift/driver contact, damage hold or stock-pending installation | Publication blocked with a concrete reason; estimate acknowledgement cannot waive it. |
| P11 | Customer has not confirmed | Publication succeeds if otherwise valid, showing awaiting confirmation; Start denied. Departure requires the next stop confirmed, not all later stops. |
| P12 | Interval/scope changes versus unchanged attachment | Changed agreement clears confirmation and preserves audit; unchanged attachment retains it. |
| P13 | First or last stop finishes early | Remaining route resource reservation survives; actual quantity only reduces obligation. |
| P14 | One stop partial, one customer absent, one successful | Continue route; exact remainder remains for later work; damage hold persists; absent customer need not sign. |
| P15 | Cancel pre-departure with created and attached visits | Created work releases; attached booking restored by default; no lost history or silent client cancellation. |
| P16 | Cancel races Crew departure/Start | Only a valid serial outcome; no cancelled route containing newly started work. |
| P17 | Return is late / unrecorded | Keep in-transit holds until actual return; then apply the explicit buffer. Capture reality despite downstream conflicts or missing reports; preserve reports as unresolved, not silently completed. |
| P18 | Collection received from customer but not accepted at warehouse | Distinct events; no fabricated warehouse availability. |
| P19 | Standalone mutation tries to bypass route ownership | Rejected or routed through the same atomic workflow; no schedule corruption. |
| P20 | Anonymous, Crew-role or foreign-origin Publish | Rejected through real guards. Removed participant loses current assignment access per existing rules. |
| P21 | Refresh while editing / publish succeeds | Keep input, scroll and expanded sections; update data and show toast; no page reload. |
| P22 | Legacy draft/standalone/completed visit and old signed document | Still readable; no automatic migration of old visits into routes or rewriting of evidence. |

These are acceptance requirements, not claims of tests already implemented or passed. Use isolated `delivery_backoffice_test` schemas with real migrations and guards. Add fault-injection rollback and real concurrent transaction checks, not repository mocks as proof of atomicity.

## Delivery order and release gate

1. Task 05: the two policy decisions are confirmed, the contract is reviewed and traced in Notion.
2. Task 06: migrations/ownership, exact review contract, transaction-scoped command reuse, atomic Publish, legacy guards, isolated PostgreSQL concurrency/rollback/auth tests and Backoffice review UI.
3. Task 07: authorized Crew route projection, stop ordering, version changes and minimum explicit departure controls; preserve standalone My visits.
4. Task 08: pre-departure amendments/cancellation and after-departure restricted exception handling.
5. Task 09: actual-return control, reconciliation, cargo receipt and repeat-work links.

Do not expose publication on the shared demo stand until the necessary departure/return/cancel controls and all reservation consumers exist together. Backend-only tests can validate task 06 first; an enabled Publish button without a way to safely execute, return or cancel is not a complete operational feature. No paid maps, real Odoo, offline synchronization, multi-vehicle/segment staffing or automatic route optimization is introduced here.

## Verification record

This task changes documentation only. On 11 November, backend `npm run typecheck` and `npm run lint` passed. The focused baseline passed **56 tests**, zero failures/skips, including real HTTP guards and uniquely owned schemas in `delivery_backoffice_test` on the existing isolated PostgreSQL 18.6 Docker service. The main demo database was not seeded, migrated or reset. Two independent read-only reviews checked current backend ownership and Backoffice/Crew flows; a further review corrected departure semantics, restoration provenance, buffer arithmetic and loading/return exceptions.

```powershell
npm run typecheck
npm run lint
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" -v "${PWD}/scripts:/app/scripts:ro" tests npx --no-install tsx --test --test-concurrency=1 test/route-calculation.test.ts test/route-work-scope.test.ts test/route-feasibility.test.ts test/route-nearby.test.ts test/work-scope.test.ts test/transport-rules.test.ts
```

Publication-specific tests, migration checks and browser acceptance remain for tasks 06–09. No new application build/browser acceptance was performed for this documentation-only change. Existing test success must not be represented as proof that Publish works.
