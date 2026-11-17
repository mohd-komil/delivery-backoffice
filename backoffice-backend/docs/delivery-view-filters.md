# Delivery view filters: isolated browser fixture

The operational delivery lists filter across the complete result set before taking the ten rows for a page. Search matches Picking, customer or a linked sale order. Counts in the sidebar describe the full lists and can overlap (an open issue can belong to a partially completed delivery).

Operational City / Province / CAP choices come from all local delivery destinations, and Team choices from the crew directory and recorded assignments. A choice with no matches in the current list stays selectable and shows `(0)`. City and province still constrain compatible choices, and a unique catalogue match can fill the related fields even when the list is empty. Planned does not offer Team because its booked visits have not been assigned. None of these choices changes the status scope of the results.

| View | Operational filters |
| --- | --- |
| Planned | Booked visit dates |
| Assigned | Team and booked visit dates |
| In progress | Team and dates on a visit in progress |
| Partially completed | Team and visit dates, including recorded visit history |
| Return visit required | Team, visit dates, requested or planned return |
| Issues | Team, visit dates, type of open issue |
| Completed | Team on completed visits, delivery completion date |

Dates are inclusive calendar days in Europe/Rome. A visit interval that ends at midnight does not overlap the new day. Where team and visit dates are combined, a single applicable visit must match both. Cancelled visits do not match. Inbox list and map retain their own filter behavior.

## Run

Use the local Docker DB and run from `backoffice-backend`. Ports 3010/3011 are shared by the isolated browser demos. Start current Backoffice source on port 3010, pointing at `http://127.0.0.1:3011/api`, as described in [the existing browser setup](stage10-acceptance.md#reproduce-the-isolated-visible-demo).

```powershell
New-Item -ItemType Directory -Force -Path '.local/filters-browser-demo' | Out-Null
docker compose --profile tools run --rm --no-deps --name delivery-filters-browser --publish 127.0.0.1:3011:3001 -e BACKOFFICE_TEST=1 -e ROUTE_PUBLICATION_ENABLED=true -e FRONTEND_ORIGIN=http://127.0.0.1:3010 -e CREW_FRONTEND_ORIGIN=http://127.0.0.1:3012 -v "${PWD}/src:/app/src:ro" -v "${PWD}/scripts:/app/scripts:ro" -v "${PWD}/local:/app/local:ro" -v "${PWD}/.local/filters-browser-demo:/app/.local/filters-browser-demo" tests npx --no-install tsx scripts/demo-route-publication.ts --filters
```

The fixture creates a dedicated schema in `delivery_backoffice_test`, with two matches for each requested view and twelve for Assigned. Issues and returns deliberately overlap Partially completed. The rows are synthetic list snapshots only. Sign in with the operator credentials in the ignored `.local/filters-browser-demo/connection.json`. Use `--filters --resume` to reopen the same fixture without reseeding.

Useful examples: Planned on 18 November 2026 shows PLANNED-B; its Catania filter shows PLANNED-A with CT and 95125. The Assigned second page contains records that can be retrieved by secondary order (DEMO/EXTRA/…). Team DEMO Ionio has six assignments. Requested returns and the Damage issue both isolate PARTIAL-A. Completion on 17 November in Rome isolates COMPLETED-A: it was closed late on 16 November UTC.

Verified in installed Chrome: all seven views returned the expected rows; Assigned started with ten rows per page and found a second-page delivery by its secondary order. Refresh sent another data request while keeping the submitted filter and the unsubmitted search text, without navigating the page. Completed was also checked at 430 px in the dark theme. The redacted run result and screenshots are in the ignored fixture directory.

The targeted backend suite passed 16 tests against isolated PostgreSQL. It covered combined dates and teams on the same visit, the Rome midnight boundary, geographic and Inbox compatibility, open issues, unresolved return states and query validation. The frontend passed 33 targeted tests covering request criteria, independent view state, Inbox/Map compatibility, pagination and background refresh. Typecheck, typed lint and builds passed for both projects.
