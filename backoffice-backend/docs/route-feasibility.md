# Route feasibility and explicit stop-order suggestions

Implemented 2026-11-11 for the local teaching environment. The application still uses independent delivery work scopes and visits. A route is a **draft**: previewing, suggesting, or saving it does not book visits, change work, assign people, allocate vehicles or publish anything to Crew.

## Inputs and meanings

- `GET /api/routes/jobs` returns the selected work per source line/order and its `workFingerprint`. Each stop carries that fingerprint when the operator reviews its work/duration. Changed source, quantities, selected appointment or readiness produces an unknown/review state rather than silently approving an old manual duration.
- `workDurationSource=remaining_estimate` recalculates minutes on the server from only the selected remaining or appointment work. This is the existing proportional source estimate with equally weighted unit-operations, **not an installation standard**. `manual` preserves the entered number; `unknown` propagates a null work duration and unknown downstream ETA/return. Legacy drafts remain readable and explicitly require review.
- A customer's window explicitly means `arrival` or `work_end`. Before the start of a window the route waits. An arrival window permits work to finish later; a work-end window does not. `unrestricted` is an explicit statement; missing semantics are `unknown`. A confirmed appointment alone does not tell the system which interpretation applies.
- `planning` records the actual participant IDs, date-specific working intervals and breaks or absences, external vehicle availability and an explicit transfer buffer. Route planning checks these facts without a separate driver. The declarations are saved in the route JSON. An empty unavailable interval list means the operator recorded no break or absence for that entry. Missing availability is unknown.
- Each participant must cover the entire departure-to-return interval and have every required skill in the linked visit task snapshots. Disabled people, crews, vehicles or required skills conflict. Default crew membership is not substituted for actual staffing. This first version uses one fixed crew/actual composition and one vehicle throughout; different visit staffing or multiple vehicles require manual review.

## Preview and conflict checks

`POST /api/routes/preview` produces the timeline and `feasibility`: `conflict`, `insufficient_data`, or `feasible_estimate`, with concrete findings, checked time and fingerprint. PostgreSQL reads use a consistent repeatable-read snapshot. The live crew/person appointment ledger and vehicle/driver transport ledger are checked through return, with the explicitly entered buffer against other reservations. Vehicle return reservations remain relevant after the service visit itself is completed. Only explicitly selected appointments with matching actual composition are excluded as own reservations; another visit on the same delivery remains a conflict.

Breaks and absences overlapping the trip are reported as conflicts; this version does not insert pauses automatically. Working intervals can cover consecutive periods, but gaps are not silently treated as work time. Unknown task snapshots, stock readiness, work duration, customer windows, external confirmations, travel legs and transfer buffers prevent a feasible result. Dates include UTC offsets and elapsed-time arithmetic handles Rome midnight/DST changes.

The fingerprint covers the input, current work/version/resource state and calculated schedule; `checkedAt` is deliberately excluded so a refresh with unchanged data is stable. Any draft/work/resource change requires a fresh check. A feasible estimate is not a reservation or a guarantee of road accessibility, traffic, ferry times, vehicle capacity or real provider availability. Future publication/booking must revalidate atomically; this feature does not implement publication.

## Suggested order

`POST /api/routes/suggest-order` accepts the draft plus `objective: travel_minutes` (the agreed initial UI priority; the contract also supports `return_time`). It compares the current order with a bounded two-pass pair-swap search, keeps all stops/work/windows/people/vehicle/start/end points, checks feasibility first, then the objective, and returns both schedules and changes in travel/total time. Status is `suggested`, `no_improvement_found`, or `insufficient_data`. The result is **not a proof of an optimal order**.

All compared orders use the same directed estimate matrix and source. When manual travel values exist, candidate directions need reviewed manual estimates too; comparing a manually entered long journey with a newly generated short coordinate estimate is rejected as insufficient data. The endpoint never calls Google; requesting a road-provider comparison is rejected. Applying a proposal is a separate explicit frontend reorder and optional draft save, with no scheduling side effects.

## Verification

Relevant commands from `backoffice-backend`:

```powershell
npm run typecheck
npm run lint
npm run build
npm run openapi
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" -v "${PWD}/scripts:/app/scripts:ro" tests npx tsx --test --test-concurrency=1 test/route-calculation.test.ts test/route-work-scope.test.ts test/route-feasibility.test.ts test/route-nearby.test.ts
```

Tests cover identical SKU lines across separate sales orders, selected-work estimates, arrival versus completion windows, unknown durations, skills, breaks, absences, return-only conflicts, exact own-appointment exclusions, external confirmation, stable/changed fingerprints, comparable estimate matrices and nonmutating suggestions. HTTP integration uses real guards and a unique owned schema in `delivery_backoffice_test`; it verifies unauthenticated/foreign-origin/invalid requests and a 17-minute estimated improvement without Google or delivery mutation. No migration or main-database update is required for the additive routing fields.

## Dedicated local demonstration

Prepared on 2026-11-11, independently of the existing Gianluca deliveries. `scripts/demo-route-feasibility.ts --seed` inserts only missing source fixtures in the local teaching database; `--test` targets the isolated test database. `--prepare` runs on the host against the loopback API, reads the existing ignored admin account file without printing credentials, creates/reuses dedicated demo directory entries, books/assigns only these three fresh deliveries and saves a route draft. It preserves existing appointments, user edits and route state. The seed replay and edit preservation are checked on isolated PostgreSQL.

```powershell
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/scripts:/app/scripts:ro" tools npx tsx scripts/demo-route-feasibility.ts --seed
npx tsx scripts/demo-route-feasibility.ts --prepare
```

- Draft: **DEMO · Catania route feasibility**, `b15b5395-8a73-4a52-9289-950000000099`.
- Deliveries: `DEMO/ROUTE/0001..0003`, UUIDs `b15b5395-8a73-4a52-9289-950000000001`, `...0002`, `...0003`; separate fictional customers/orders with the same demo chair SKU at public Catania reference buildings, not real customer entrances.
- Dedicated resources: **DEMO Route Marco Rossi**, **DEMO Route Preview**, **DEMO Route Preview van**. The draft selects the actual participant and driver and records date-specific working availability. The route itself does not allocate the vehicle or publish to Crew.
- 16 November 2026: departure **09:00 Europe/Rome**, work **95 minutes**, current coordinate-estimated travel **18 minutes**, return **10:53**. Explicit stop-order suggestion: travel **15 minutes**, return **10:50**, **3 minutes** saved on the same approximate matrix. The script leaves the suggestion unapplied for browser review.
- Preview with the shift ending before the return reports `conflict`; preview with unknown customer windows reports `insufficient_data`. These diagnostic previews are not saved over the valid demonstration draft.

Detailed response evidence is in ignored `.local/route-feasibility-demo-evidence.json`, with no credentials. A narrowly guarded one-time `--repair-empty-contact` helper repairs only the exact pristine first-version fixtures produced by an earlier run of this same script that omitted the required fictional contact phone; it never rewrites an edited or booked fixture.
