# Synthetic city, province and postal-code filters

## Calendar destination projection — 2026-11-13

`GET /calendar?from=…&to=…` also returns `geography` for each appointment: nullable `city`, `province`, `postalCode`, and provenance `source` (`odoo`, `synthetic_fixture`, or null). It uses the same `deliveryGeography` resolver as the delivery list, preserving leading postal-code zeros and rejecting stale address-bound teaching metadata. This adds no write, migration, per-visit detail query or Odoo access; existing interval limits, authorization and drawing redaction remain unchanged.

Following the user's correction, filter choices come from `GET /calendar/filter-options`, independently of the current date range and appointments. `destinations` contains case-insensitively grouped city/province/postal-code triplets with delivery counts across every local delivery, including unbooked and completed work. `crews` contains all current crew IDs, names and enabled flags, including unused and disabled teams. The catalogue reads only source-customer/address-geography projections instead of products and results, and does not inherit the delivery-list store's 5000-row bound. It uses the authoritative geography resolver and normal Backoffice authentication. No date-query parameters are accepted.

Validation: backend typecheck, full typed lint and 21 focused tests in `participant-calendar.test.ts` / `delivery-geography.test.ts` passed. The HTTP tests use real guards and owned schemas in Docker PostgreSQL `delivery_backoffice_test`; they verify source and synthetic geography, leading zeros, range validation, anonymous rejection and unchanged business records. The catalogue tests also cover an empty calendar month, destinations from all delivery pages, an out-of-period visit and unused active/disabled teams. Live API deployment is performed separately from these checks.

**Current stand, 2026-11-09:** all `Via Dimostrativa` addresses now have [public venue reference addresses and sourced CAP values](public-demo-addresses.md). Historical synthetic CAP groups below describe the earlier fixtures. Filter behavior is unchanged; current choices/counts come from the updated data.

City continues to come from the existing read-only source snapshot. Province and postal code for the local stand are teaching metadata in `delivery.data.addressGeography`:

```text
addressKey, sourceCustomerId, province, postalCode, source: synthetic_fixture
```

The metadata belongs to the exact customer and current street/city/country. It is separate from Odoo data and from `routePoint` or confirmed unloading entrances. If the address/customer changes, it must not be used for the new destination. Real Odoo province/CAP mapping remains a later integration task.

## Repeatable opt-in population

Run from `backoffice-backend` after rebuilding the compatible tools/backend images:

```powershell
docker compose --profile tools build tools
docker compose --profile tools run --rm tools npx tsx scripts/demo-geography.ts --apply
```

The command authenticates the existing demo operator and signs out afterward. It uses only the local named application databases on PostgreSQL port 55432, refuses production mode, and calls no Google API. It preserves all existing `addressGeography` values, including incomplete/stale records, and updates only missing metadata for the exact `odoo_mock` fixtures 1–20. It increments the delivery version and adds a `demo.geography_added` audit event. No source snapshots, city names, coordinates, entrances, schedules, quantities or execution history are replaced.

The original fixture identity/address checks are shared with the coordinate script through `scripts/demo-fixtures.ts`. `DEMO/OUT/0012` has no street and intentionally remains without province/CAP, providing an incomplete-address example.

## Synthetic filter groups

The CAP values below are realistic-looking Italian values assigned to fictitious streets for testing. They do not establish actual postal coverage for the artificial coordinates.

| City | Province | Postal code | Picking numbers with these fixtures |
| --- | --- | --- | --- |
| Catania | CT | 95121 | 0001, 0002, 0005, 0009, 0013, 0017 |
| Catania | CT | 95125 | 0003, 0007, 0011, 0015, 0019 |
| Messina | ME | 98121 | 0006, 0010, 0014, 0018 |
| Messina | ME | 98122 | 0004, 0008, 0016, 0020 |
| Messina | Missing | Missing | 0012 |

These are counts across the 20 source fixtures. Inbox results depend on the normal delivery state, and completed/assigned jobs do not become Inbox jobs because metadata was added. A repeated population command leaves existing rows and audits unchanged.

## Verification

```powershell
node --import tsx --test test/demo-geography.test.ts test/demo-coordinates.test.ts
npm run typecheck
npm run lint
```

The geography regression uses its own schema in real `delivery_backoffice_test` PostgreSQL. It checks concurrent repeated population, existing/stale metadata, changed and incomplete addresses, source identity isolation, expected CT/ME and CAP groups, exact preservation of all other delivery data and confirmed entrances, and the production-mode guard.

## Local deployment verified 2026-11-09

Backend typecheck, typed lint, build and the complete 158-test suite passed. Backend/tools Docker images were rebuilt, the main source/application databases backed up, and the seed applied: 19 updates, 0012 skipped, repeat 0. Backup and preservation reports are in `.local/backups/docker_20261109T131156Z_4cc10345`. Comparison verified that the 20 delivery records changed only by the intended 19 metadata/version updates; prior history, source records, coordinates, entrances, visits, quantities and other business tables were preserved, with 19 new audit events. No migration was required. Backend/database health passed and the importer succeeded on 20 Picking.

Authenticated live API and browser checks found 15 Inbox deliveries: Catania 6, Messina 9; CT 6, ME 8, missing 1; CAP 95121: 3, 95125: 3, 98121: 4, 98122: 4, missing: 1. Catania + CT + 95121 returns 0005, 0009, 0017. Messina + ME + 98121 returns 0006, 0010, 0014, 0018. Missing CAP returns 0012. Catania + ME returns 0. The original global-facet behavior was subsequently replaced by the cascading rules below; global sidebar counts remain independent of filtering. Unfiltered page 2 contains 5 records.

Frontend production runs at `http://127.0.0.1:3000/?view=inbox`. The browser verified reset to page 1, Clear filters, Refresh/state preservation, unaffected Completed view, return to Inbox, and existing Nearby work. See the frontend [design-system verification](../../backoffice-frontend/docs/design-system.md) for screenshots and responsive checks.

## Filtered Inbox map — 2026-11-09

Authenticated `GET /api/deliveries/map?view=inbox` applies the same authoritative list selector and exact city/province/postal-code/search criteria before producing all matching markers. Pagination parameters are rejected. The response includes total/mapped/missing counts, minimal delivery labels and geography, and a separate list of deliveries without usable coordinates. The current confirmed unloading entrance has priority over a reference point. Address/customer changes invalidate stale points through the existing source/import rules. Deliveries at the same point remain distinct IDs. This endpoint performs no writes or Google calls and preserves the existing authentication/authorization boundary.

Typecheck, typed lint, build and the complete 163-test backend suite passed. Real PostgreSQL checks cover more than one page, overlapping coordinates, missing/incomplete addresses, current/stale/foreign entrances, filter parity, leading-zero CAP, strict query rejection and authentication. Backend/tools images were rebuilt and the healthy backend replaced without resetting either database; no migration or additional seed was needed. Read-only live API comparisons matched the table IDs for all tested filter combinations, including all15 Inbox deliveries (14 mapped,0012 missing) and Catania + CT + 95121 (0005,0009,0017).

Deployment comparisons are stored under `.local/map-deployment-20261109`. Seventeen business tables, fake Odoo tables/sequences, existing business history, delivery versions and coordinates were unchanged; routine import/session maintenance was excluded from those comparisons. The map is a local demonstration using synthetic points, not evidence of verified client addresses. Real source-field mapping and production map-provider selection remain separate work.

## Cascading geographic choices — 2026-11-09

The existing `geographyFacets` response shape is retained and follows City → Province → Postal code:

- `cities` covers the whole selected delivery view.
- `provinces` respects the selected `city` or `cityMissing`.
- `postalCodes` respects the selected city and `province` or `provinceMissing`.

Each facet ignores its own selection and all lower fields. Options and their counts use every matching record in the selected view, not only the current page. They deliberately remain independent of text search so a temporary search does not remove geographic choices. The actual table and map results still apply text search and all selected geographic filters together with AND; a contradictory city/province selection returns no results, rather than silently changing the query. Null options represent missing or stale geography, and CAP values remain strings to preserve leading zeros.

In the current demo, Catania offers only CT and CAP 95121/95125. Messina offers ME and missing province; choosing ME limits CAP to 98121/98122, while missing province leaves only missing CAP. Changing city in the UI clears province and CAP; changing province clears CAP. Refreshing the same query preserves selections. No database migration, seed, Google API request or source modification is needed for this change.

Backend typecheck, full typed lint, build and all 13 PostgreSQL geography/map regression checks passed. Run those regressions with `npx tsx --test --test-concurrency=1 test/delivery-geography.test.ts test/delivery-map.test.ts`. The backend Docker image was rebuilt and the backend alone restarted with `docker compose up -d --no-deps --wait backend`; existing database volumes and importer were retained. Authenticated live checks verified Catania 6, Messina 9, Messina + ME 8, and Messina + missing province 1, along with unchanged map totals, sidebar counts and search/page-independent options. Delivery data/versions/source snapshots/coordinates, entrances, route drafts and business history were hash-identical before and after deployment. Reports are under `.local/cascade-deployment-20261109`.

## Reverse geographic selection — 2026-11-09

`GET /api/deliveries` additionally returns `matchingGeographyFacets` with the same `cities`, `provinces` and `postalCodes` arrays of `{ value, count }`. This group uses every record in the selected delivery view matching **all** selected geographic filters, including missing flags. Text search and pagination do not affect these values. Existing cascading dropdown options, table/map filtering and sidebar counts retain their behavior.

The UI can use these matches to fill unset geographic fields only when the remaining choice is unambiguous. For example, the demo's CT province identifies Catania but leaves two possible CAP values; CAP 95121 identifies both Catania and CT. A CAP shared by different cities or provinces preserves every possibility. Null is returned explicitly, not guessed as a known address value. Contradictory filters produce three empty arrays. This is inference from the current delivery dataset, not an authoritative Italian geography directory; it does not write delivery/source metadata or query Google.

Facet grouping and filtering compare values case-insensitively but preserve a matching record's spelling. When an inferred value differs from an existing option only by case, the UI should reuse that option's value rather than creating a second choice.

Backend typecheck, full typed lint, build and all 15 PostgreSQL geography/map checks passed for this addition. Regression fixtures include a shared leading-zero CAP in two different cities/provinces, null/missing data, more than one page, contradictory filters and isolation by delivery view. The rebuilt backend is healthy in Docker. Authenticated live checks verified CT → Catania with two CAP values, 95121 → Catania + CT, explicit missing values, unchanged search/page inference and list/map counts. The deployment preserved delivery/source/version/coordinate data, entrances, routes and business history; no migration or seed ran. Reports are under `.local/reverse-geography-deployment-20261109`.

## Inbox area and planning summary — 2026-11-09

List items additionally return `planning`: authoritative operational `status` (including `awaiting_closure`), `activeVisits`, and `remainingWorkEstimate`. Active visits contain their IDs, booked/in-progress statuses, start/end instants and assigned crew ID/name snapshots. In-progress visits sort first, then booked visits by start time. Completed, cancelled and failed visits are excluded from this current summary regardless of their dates; the underlying history stays intact.

The shared estimator is used by the list, Routes and Nearby work. It scales the source's full-work `estimatedMinutes` by the fraction of remaining **line unit-operations** and rounds up to a whole minute. Each required delivery, installation or collection of one unit has equal provisional weight; delivery-plus-installation therefore contributes two operations. It uses current per-line service requirements and effective corrected results, not just delivered quantity. This assumption is transparent teaching logic until real source/service timing is agreed. It excludes driving, loading, access overhead, checklist-only tasks and other work without quantities. Zero means no remaining line operations, not permission to close the delivery.

The estimate shape is `{ minutes, basis, sourceMinutes }`, where `basis` is `proportional_remaining_operations`, `no_remaining_work`, or `unknown`. Mixed units, source review and empty required scope yield unknown. Missing source minutes yield unknown while work remains. A completed delivery flag never hides remaining quantities. Estimates above 1440 minutes are returned in full; the existing single-stop `suggestedWorkMinutes` is null for such jobs instead of silently reducing their duration. Route jobs include the same estimate object; the route's own explicitly entered work duration remains editable.

Both `/api/deliveries?view=inbox` and `/api/deliveries/map` accept `north`, `south`, `east`, `west` together as decimal query strings. Latitude bounds are -90…90, longitude -180…180; south must be less than north and west less than east. Bounds do not wrap across the antimeridian. Area filters apply inclusively to every matching Inbox record before pagination using the current confirmed entrance, otherwise the valid reference point. The map and list use one shared selection rule and point resolver.

Both responses include nullable `area`: `{ bounds: { north, south, east, west }, excludedMissingCoordinates }`. With an area, missing/incomplete addresses or coordinates are excluded. The excluded count is evaluated against the other active geographic/text filters before applying the rectangle; it distinguishes missing points from known points outside the area. Returned totals count only jobs inside the area. Geographic option facets are scoped to the selected area but keep their hierarchy and independence from search/page; sidebar counts remain global. No Google request, migration, geocoding or data mutation is involved.

Backend typecheck, full typed lint, build and all 35 focused tests passed: `npx tsx --test --test-concurrency=1 test/delivery-planning.test.ts test/delivery-map.test.ts test/delivery-geography.test.ts test/route-nearby.test.ts test/importer.test.ts`. PostgreSQL fixtures verify partial quantities, remaining installation and collection, superseded results, unknown/long estimates, multiple current visits and crews, terminal-visit exclusion, inclusive area boundaries, point precedence, missing/stale coordinates, full-view pagination/facets and list/map parity. They retain the real HTTP guard and check that reads do not mutate delivery data or history. This change requires only a compatible backend rebuild, without a migration or seed.

Section2 local rollout completed on2026-11-09: backend runtime rebuilt and restarted with `docker compose up -d --no-deps backend`; API and PostgreSQL are healthy. No migration/seed or source mutation was performed. Frontend production3000 was rebuilt. The authenticated frontend `test/section-two.smoke.ts` passes against the real Docker API and checks current visits, progress/detail parity, shared Routes estimates, fixed Catania bounds, list/map ID parity, intersected filters and invalid/unauthenticated requests. Browser evidence is recorded in frontend `docs/design-system.md`.

Preservation report: `.local/section-two-deployment-20261109/preservation.json`. Delivery rows, entrance records and route drafts are hash-identical; pre-existing audit rows also match. The aggregate audit digest changed only because the already-running importer continued to append `import.started`/`import.finished`; those new events were inspected separately, not erased or treated as user-data changes.
