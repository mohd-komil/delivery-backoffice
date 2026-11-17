# Repeated imports and source reconciliation

Task 16 follows the prior-work checkpoint. External Odoo remains read-only. Source revisions belong to the application import metadata, not to immutable Crew reports or published route snapshots.

## Accepted scope and incoming candidates

The source adapter reads a Picking and the linked-record revision evidence from the same read-only, repeatable-read database transaction. Row order and read time do not establish source freshness. Compare individual linked-record versions, preserving sub-millisecond timestamps. An older export must not replace a newer accepted snapshot.

A completed SQL read does not prove that the upstream export or database copy contains every business record. A missing product line is therefore a review case, not an instruction to cancel work. Equal-version conflicting content, mixed old/new linked revisions and insufficient ordering evidence must remain explicit.

While a candidate waits for review, `delivery.source` retains the accepted scope. This preserves local service and time choices, prior-work balances, signed results, assignments and route snapshots. A pending change blocks new planning and new starts. An already-started visit may finish against its unchanged accepted scope; an import must not strand its report merely by replacing its source underneath it.

## Dispatcher decision

The authenticated Backoffice review presents accepted and incoming values, provenance confidence and server-calculated acceptance blockers. A decision requires a current delivery version, exact candidate identity/hash, request ID and explanation.

- Accept only when the candidate can be applied without reassigning historical work to another physical line or invalidating live route ownership. Existing published routes use the normal cancellation/replanning or return/reconciliation workflows first.
- Keep the accepted scope when the incoming candidate is unsuitable; retain who made that decision and why. Repeating that identical rejected payload must not create another case. A different candidate must be reviewed again.

Keeping an accepted snapshot cannot make a missing, invalid or out-of-filter Picking eligible for new planning. Import eligibility and the content-review decision are separate facts. A dispatcher note cannot waive signed-evidence, prior-work or resource rules.

The review endpoint is `GET /api/deliveries/:id/source-review`. Decisions use `POST` on the same path with `version`, `requestId`, `candidateId`, `candidateHash`, `action` (`accept` or `keep_accepted`) and `reason`. The response is the refreshed delivery detail. Identical retries use the original request ID and payload; changing the payload requires a new request ID.

Accepting an incoming service change preserves existing selected operations and saved local work times. Any previously source-owned service choice retained from the earlier snapshot becomes an explicit local choice, with the before/retained plan audited. Review services separately in the product lines when a different operational scope is intended. This does not freeze a provisional source-level duration where no local work-time estimate has been saved.

## Coverage and recovery

The current customer adapter does not import external document revisions or authoritative prior delivery/installation events. Their coverage remains unknown; neither read time nor a cumulative sales-order quantity substitutes for those missing facts.

Imports use per-record application transactions. If a later record fails, earlier committed records remain. Retry must resume safely without duplicating quantities, decisions or candidates. PostgreSQL regression fixtures must use owned isolated schemas; do not modify external Odoo to manufacture a test revision.

The initial 12 November checkpoint passed 48/48 PostgreSQL tests across importer, Odoo18 adapter, source-review HTTP, prior-work HTTP and work times. This includes newer-then-older replay with microsecond clocks, linked-row regressions against both accepted and pending revisions, removed-line retention, superseding an obsolete proposal, a failure after a committed prefix, and retry recovery. Adapter tests verify that payload and revision evidence share one repeatable-read snapshot and that missing clocks remain unavailable. Source-review HTTP tests use normal authentication and prove that an already-started Crew report can finish against accepted scope.

Frontend verification passed 240/240 tests, strict typecheck, typed lint and production build; the final service-retention notice and regression message passed the focused seven-test group plus typecheck and lint. Backend strict typecheck, typed lint and build passed. The full backend run passed 355/356 before updating one obsolete public-address fixture to use an explicit source-review decision after signed work. That corrected fixture and the importer group then passed 21/21; no known task-16 failure remains.

A fresh full regression and runtime upgrade follow the combined development batch. This document does not assert that a pending candidate has been accepted or that the primary runtime is already upgraded.
