# Shared departure and return locations

The operator-maintained catalogue is available through `GET/POST /api/planning/locations` and `GET/PATCH /api/planning/locations/:id`. Normal Backoffice authentication and Origin enforcement apply. A write requires an explanation, a request UUID and, for updates, the current version. Repeating the same actor-bound command returns its saved response; changed input or stale versions conflict. Locations are disabled rather than deleted. Each revision retains its fields, author and explanation.

Each location stores an address, an address point and an optional unloading entrance. The entrance takes precedence for travel calculations. A non-demo point requires operator confirmation before route publication. Unknown, disabled or unconfirmed endpoints remain explicit feasibility findings; drafts can still be saved. This catalogue does not call a geocoder or modify Odoo.

The migration preserves the four existing demonstration identifiers and their coordinates. They remain labelled demonstration references, not company warehouses. Real warehouse addresses and entrance positions must be supplied and confirmed by an operator.

Routes choose departure and return independently. Previews use current catalogue revisions. Point/address changes invalidate related reviewed manual legs; endpoint versions participate in the route feasibility fingerprint. The old fixed demo travel matrix is rejected for a demonstration endpoint whose coordinates were changed.

Publication and amendment capture location snapshots in the immutable route review. A later catalogue edit requires review/amendment before departure; historical names and coordinates remain frozen. The original four legacy publication endpoints retain their original names and must be reviewed after catalogue changes. After departure, catalogue maintenance does not prevent Crew reports, finishing a visit or recording actual return.

Migrations `PlanningCatalogueCommands1793701500000` and `PlanningLocations1793701600000` create new catalogue/receipt/history tables. They do not rewrite Picking data or source tables. Rollback is intentionally a reviewed recovery operation so history is not silently destroyed.

Verification: `test/planning-locations-http.test.ts` passes 5 checks on isolated PostgreSQL schemas. It exercises real HTTP authentication and Origin guards, actor-bound retries, conflicting concurrent revisions, immutable history, repeated migration runs, separate start/return points, unloading entrances, missing/unconfirmed/disabled coordinates, stale manual legs and publication reviews, frozen revisions, route amendment and successful report/return after a later catalogue edit. No external geocoding API is called. Shared project typecheck, typed lint, regression and runtime deployment are recorded with the overall implementation checkpoint.
