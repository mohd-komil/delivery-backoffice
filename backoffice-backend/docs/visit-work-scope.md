# Services and work planned for each visit

Stage 1 · 10 November 2026 · [development plan](https://app.notion.com/p/40c4433fac0f815ab7e5fb9257f22047).

An appointment now reserves explicit operations and quantities from the remaining work of its Picking. Booking a repeat visit does not copy the original full order. Crew can report only the operations and quantities included in that visit's plan. Closing the Picking remains a separate Backoffice action.

## Product-line service and identity

Supported services are `delivery_only`, `delivery_installation`, `installation_only` and `collection_only`. The delivery default applies to each inheriting product line; an operator may override an individual line before it has planned or recorded work. Changing the default preserves explicit overrides and the effective service of lines with planned or recorded work.

Each line is identified by `sourceLineId` and retains its sales order. A product ID or SKU is not a work-accounting key: two orders containing the same chair have independent quantities, reservations, reports and evidence.

The teaching source maps exact codes `delivery` → `delivery_only` and `delivery_and_assembly` → `delivery_installation`, and accepts the four canonical service codes. Unknown values require an explicit operator decision; no fuzzy label matching is used. The mapping does not establish the real client's Odoo schema. Existing local service decisions are retained. A legacy row with recorded work and no local service plan is not silently reinterpreted through a newly recognised source code.

## Total, actual, remaining and available

Delivery, installation and collection have separate counters, stored as integer thousandths of the source unit: `1000` means one unit and `500` means half a unit.

For each line and operation:

- **Total** is the obligation defined by the product quantity and chosen service.
- **Actual** comes from effective recorded results, including the existing correction rules.
- **Remaining** is total minus actual.
- **Reserved** is the work allocated to booked or in-progress visits.
- **Available** is remaining minus reserved, bounded at zero.

The server checks the version, current source and reservations under the existing scheduling lock. Concurrent bookings cannot reserve the same available quantity twice. Replaying an unchanged `requestId` does not create another visit. Reusing it for different input is rejected.

Cancelling a visit releases its reservation and existing resource allocations through the normal cancellation flow; it does not erase the visit or earlier results. Finishing a partial visit releases the unperformed part of that visit's plan. Only actual work reduces the remaining obligation. An unsuccessful customer-absent attempt leaves its unperformed work available for planning.

## Booking and review API

Authenticated Backoffice admin/operator commands use the delivery version and the existing Origin and role checks:

| Endpoint | Required work fields |
| --- | --- |
| `POST /api/deliveries/:id/appointments` | `version`, `requestId`, `startsAt`, `endsAt`, optional `returnRequestId`, `workLines` |
| `PATCH /api/deliveries/:id/appointments/:appointmentId/work-scope` | `version`, `requestId`, `reason`, `workLines` |

Each `workLines` entry contains `sourceLineId`, `deliveryMilli`, `installationMilli`, `collectionMilli` and optional `customerStockConfirmed`. Send 1–500 distinct source lines, with at least one positive operation on each selected line. All quantities are nonnegative integers bounded by the available work. Unselected lines are omitted. Unknown lines, unsupported operations and excessive quantities are rejected.

The stored `workScope` includes a revision, the confirming operator and time, a material-source fingerprint, and snapshots of each selected source line and service. Rescoping a booked visit requires a reason and clears customer confirmation, because the agreed work has changed. History retains both plans and the previous confirmation. Assignment, responsibility, transport and confirmation remain separate existing commands.

## Existing visits and source changes

Old records remain readable without inventing a plan or rewriting completed history. An active visit without `workScope` requires explicit dispatcher review. New booking is blocked while an unresolved legacy active scope makes its reservations unknown.

Ordinary rescoping is allowed before a visit starts. A narrow legacy exception permits review of an already started visit only when it has no scope and no results; it preserves the actual start and existing operational context. A started visit with an agreed scope cannot be silently replanned.

Material changes to the source line identity, product, quantity, unit, order linkage or destination invalidate the agreed plan and require review. Source notes alone do not invalidate it. New results capture `workScopeSnapshot` beside source, service, instructions, assignment and checklist snapshots. Older results remain unchanged and continue to display as historical records.

## Installation prerequisites and Crew

Future installation may be booked before an earlier delivery has physically happened. It reserves installation work but does not create a delivered fact. Until enough product is already at the customer, or is included as delivery on this same visit, Crew shows `stock_pending` and cannot start that installation visit.

At Finish, installation cannot exceed stock previously delivered plus the quantity actually delivered in that report. A planned delivery by another future visit is not stock. Other started installation visits' stock requirements are also considered so concurrent visits cannot consume the same delivered units.

For `installation_only`, the dispatcher explicitly confirms `customerStockConfirmed: true`, meaning the selected product is already at the customer. The confirmed plan records who accepted that prerequisite and when, without fabricating delivered quantities.

Crew retains product/order context but distinguishes unplanned lines. Quantity inputs are limited to selected operations and the plan's caps; the backend enforces the same rules. Customer confirmation, actual staffing, responsible participant, checklist, photos and signature requirements remain active. A visit may finish its own planned work while the Picking still has other work remaining.

## Routes and estimates

A route stop may bind to a specific `appointmentId`. That stop uses the selected visit's exact work and, when confirmed, its customer window. An unbound stop uses only available, unreserved work. The system does not borrow a window merely because the Picking has one booked visit.

Routes can plan a future installation with a stock-pending warning. Legacy or changed scopes require review. Inbox Nearby work cannot add fully reserved work as an unbound stop; the dispatcher selects its booked appointment in Routes instead.

On-site suggestions remain proportional estimates from the source duration and selected unit-operations, not a measured installation model. Unknown services or incompatible units require manual review. Travel estimates remain labelled as estimates; this stage enables no paid maps service or route optimisation.

## Verification and demo acceptance

Focused checks already run during this stage:

- 13 route calculation/projection unit tests, including same-SKU order separation and future-installation planning.
- 6 isolated PostgreSQL route/Nearby checks with real authorization, atomic retries, exact appointment windows and stale-scope rejection.
- 14 Crew HTTP/PostgreSQL checks, including scoped reporting, signatures, partial work, customer absence and route integration.
- 5 Routes UI tests and 8 Inbox Nearby UI tests, including preserved selections on Refresh and rejection of fully reserved one-click work.
- Backend typecheck and scoped typed lint; frontend scoped typed lint.

Final verification on 2026-11-10: **208/208 backend tests passed**, with zero failures or skips, against isolated PostgreSQL using the `tests` Compose service and fresh read-only source/test/script mounts. Typecheck, typed lint and build passed. The final Backoffice suite passed **177/177** and Crew **21/21**, with their typechecks, typed lint and production builds passing. Logs are under the projects' ignored `.local` directories.

Chrome acceptance used `DEMO/GIANLUCA/0001`: the same chair appears in two sales orders. Order `9201` line `920011` needed **delivery 1 and installation 2**; order `9202` line `920021` needed **no further work**. The old unscoped demo follow-up was cancelled with a reason and its linked return request rebooked for 11 November, 10:00–11:00 Europe/Rome. New visit `8cb84445-1eee-46d2-be19-270f9f91135c` contains only line `920011`; the same crew, responsible participant and vehicle were reassigned through authorized UI. A full local backup was taken before the demo mutation.

The reserved operations became unavailable for another booking, and Crew displayed the other same-SKU order as unplanned. The signed first-visit result, photos and signatures remained unchanged: the result-array digest stayed `38e2aad758c077aab3e11e4c30830ed1`. The new visit was observed in progress at the end, with only its planned quantities in the result form; no new report was submitted during this check. See [Backoffice browser evidence](../../backoffice-frontend/docs/visit-work-scope.md#chrome-demonstration).

The backend and tools images were rebuilt and backend/importer restarted. The importer completed the 20-picking scan without writing to fake Odoo. PostgreSQL stayed on the existing isolated local volume; no schema migration or data reset was needed for this additive JSON scope model.

Run focused backend checks on the existing Docker test environment:

```powershell
npm run typecheck
npm run lint
docker compose --profile tools build tools
docker compose --profile tools run --rm --no-deps tools npx --no-install tsx --test --test-concurrency=1 test/work-scope.test.ts test/work-scope-http.test.ts test/route-work-scope.test.ts test/route-calculation.test.ts test/route-nearby.test.ts test/crew-access.test.ts
```

Database tests verify `delivery_backoffice_test`, create uniquely owned schemas and clean only their own resources. Do not reset or reseed the main database to run them. Runtime and source connection instructions remain in the [Docker runbook](docker.md); Odoo access remains read-only. This stage adds optional JSON fields to existing application records and does not require a schema reset.
