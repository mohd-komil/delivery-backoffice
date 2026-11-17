# Stage 10: two-Picking acceptance · 12 November 2026

This is an authenticated synthetic-data acceptance scenario, not a real Odoo compatibility or field-pilot result. All mutations use an owned schema of `delivery_backoffice_test` and separate private-file storage. Main `delivery_backoffice`, `odoo_mock`, existing signatures and ordinary ports 3000/3002 are preserved.

## Expected and observed work

Both Pickings contain the same teaching product (`productId: 9701`, “DEMO Oak chair · same SKU, separate orders”). Every line starts with two units requiring delivery and installation. Identity is the delivery/Picking and exact source line; neither SKU nor the intentionally repeated line numbers alone identifies the work.

| Picking | Order / line | Delivered | Installed | Repeat delivery | Repeat installation |
| --- | --- | ---: | ---: | ---: | ---: |
| DEMO/STAGE10/0101 | 1010 / 101 | 2 | 1 | 0 | 1 |
| DEMO/STAGE10/0101 | 1011 / 102 | 1 | 0 | 1 | 2 |
| DEMO/STAGE10/0102 | 1020 / 101 | 0 | 0 | 2 | 2 |
| DEMO/STAGE10/0102 | 1021 / 102 | 0 | 0 | 2 | 2 |

The first report has an independent teaching photo for each order line, both explicitly synthetic signature drawings and incomplete-work reasons. The second visit uses **Customer absent**, records the reason, and creates no handover report or customer signature. Its complete work remains outstanding.

The first trip records departure, actual return, independent dispatcher custody/reconciliation and route closure. Closing the trip does not complete either unfinished Picking. The follow-up route contains precisely the quantities above, including installation-only work for line 101 of Picking 0101. It remains **published / awaiting customer confirmation** for hands-on review. The automated regression separately executes both follow-ups, closes the deliveries and verifies that the original reports and failed attempt remain unchanged.

## Reproduce the isolated visible demo

Run from `backoffice-backend` with the existing Docker DB running. Use the installed Docker CLI (on this workstation it is under `%LOCALAPPDATA%/Programs/DockerDesktop/resources/bin`). Do not run main seeding/reset commands.

```powershell
New-Item -ItemType Directory -Force -Path '.local/acceptance-browser-demo' | Out-Null
docker compose --profile tools run --rm --no-deps --name delivery-stage10-browser --publish 127.0.0.1:3011:3001 -e BACKOFFICE_TEST=1 -e ROUTE_PUBLICATION_ENABLED=true -e FRONTEND_ORIGIN=http://127.0.0.1:3010 -e CREW_FRONTEND_ORIGIN=http://127.0.0.1:3012 -v "${PWD}/src:/app/src:ro" -v "${PWD}/scripts:/app/scripts:ro" -v "${PWD}/local:/app/local:ro" -v "${PWD}/.local/acceptance-browser-demo:/app/.local/acceptance-browser-demo" tests npx --no-install tsx scripts/demo-stage10.ts
```

This server creates a fresh owned namespace, two Pickings, a crew/vehicle, and a published two-stop route. Normal credentials and guards remain active. The only direct inserts are synthetic source/identity fixture setup. Execution, publication, booking, results and reconciliation use the same authenticated HTTP/domain operations as the applications.

In another **host** PowerShell terminal, from the backend directory:

```powershell
$env:BACKOFFICE_TEST = '1'
npx --no-install tsx scripts/demo-stage10-report.ts
```

The host command intentionally calls loopback API port 3011. It must not run in an ordinary tools container where loopback refers to that container. It asserts the table above, replays the same report and absence commands, closes the first route and publishes the remaining-only follow-up. It requires a fresh published fixture and refuses to overwrite an already executed demo.

Private generated credentials and IDs are in `.local/acceptance-browser-demo/connection.json`; the noncredential outcome is in `result.json` beside it. These files and screenshots are ignored and are not available in a fresh checkout. Never commit the manifest or copy credentials into Notion. Before creating another fresh demo, retain the old manifest under its schema name if access to that demo is needed. Previous schemas and evidence are not deleted.

To resume the currently saved demo, stop only `delivery-stage10-browser`, then repeat the server command with `--resume` after `scripts/demo-stage10.ts`. This validates and reopens the exact saved namespace without reseeding. Do not rerun the report command on an executed fixture.

Separate frontend copies use current source and their own `.next` output. On this workstation:

```powershell
# C:/Users/MOHD/AppData/Local/Temp/backoffice-publication-browser-20261111
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3011/api'
node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3010

# C:/Users/MOHD/AppData/Local/Temp/delivery-crew-lifecycle-20261111
$env:CREW_API_ORIGIN = 'http://127.0.0.1:3011'
$env:BACKOFFICE_TEST = '1'
node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3012
```

The existing copies were compared with current source. Their dependency junctions require Webpack; Turbopack cannot resolve packages outside those copy roots. The main applications keep their own builds and API 3001.

## Four-stop Catania demo

Run the same Docker command with container name `delivery-four-stops-browser`, the `.local/four-stops-browser-demo` mount in place of `.local/acceptance-browser-demo`, and `scripts/demo-route-publication.ts --four-stops` as the script. Create the mount directory before starting. The isolated browser demos share port 3011. Use `--four-stops --resume` to reopen the saved schema without reseeding. Open [Backoffice Routes](http://127.0.0.1:3010/?section=routes) and [Crew Routes](http://127.0.0.1:3012/routes) with the respective demo accounts in the ignored `connection.json`.

`DEMO · Four stops in Catania` starts published with one crew, one vehicle, a responsible participant and no driver allocation. Three visits are confirmed. The fourth remains awaiting customer confirmation. Keep this run open for interactive use, or run `$env:BACKOFFICE_TEST='1'; npx --no-install tsx scripts/demo-route-four-stops-report.ts` on the host to verify the full scenario through authenticated API commands. An independent check can use port 3041 with `--four-stops --smoke`, the `.local/four-stops-browser-demo-smoke` mount, and `--smoke` on the report command.

| Stop | Expected and checked result |
| --- | --- |
| Via Etnea 397 | Deliver two cabinets and complete the stop. |
| Piazza San Francesco d'Assisi 3 | Deliver one of two cabinets and leave one for rescheduling. |
| Via Giuseppe Perrotta 12 | Install two previously delivered cabinets. The visit contains assembly only. |
| Via Simeto 23 | Reject Start while confirmation is pending. A reasoned dispatcher skip leaves both cabinets to reschedule. |

The scripted run verifies a photo and both synthetic signatures in History for each completed report, actual return by the responsible participant and dispatcher closure with the two outstanding quantities intact. Keep the test output in `result.json` beside its manifest.

## Regression evidence

`test/stage10-acceptance.test.ts` runs one complete HTTP journey with real authentication and a random owned PostgreSQL schema. The equivalent fixture uses source-line IDs 31/32 and a different teaching product ID, with the same expected quantity matrix. It checks:

- A failure at command-receipt insertion rolls back delivery state, evidence metadata, reservations and receipts.
- Replaying a committed report or Customer absent command with the original request ID and version changes none of those facts. The first success response is deliberately discarded to simulate an uncertain outcome.
- Changed payload under the same key and an unauthorized participant's replay are rejected.
- The second Picking remains unaffected by the first Picking's report, despite matching product and line numbers.
- Actual return, reconciliation and route closure preserve remaining work.
- Completed/reserved quantities cannot be booked again; valid follow-ups finish exact remaining work and preserve original signed/failed history.

```powershell
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" -v "${PWD}/scripts:/app/scripts:ro" tests npx --no-install tsx --test test/stage10-acceptance.test.ts
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" -v "${PWD}/scripts:/app/scripts:ro" tests npm test
npm run typecheck
npm run lint
npm run build
```

Recorded full backend run: **264 passed, zero failures/skips**, PostgreSQL 18.6. The focused new scenario also passed independently. Backend typecheck, typed lint and build passed. Backoffice typecheck, typed lint and **207 tests** passed. Crew typecheck, typed lint and **43 tests** passed, including two new API reliability tests. They verify safe upstream failure, no hidden retry, byte-identical explicit retries and rejection of malformed success responses. No production frontend source changed, and the running production builds were not rebuilt; separate current-source dev instances serve browser acceptance.

## Desktop Chrome acceptance

Verified in installed Chrome using a separate ordinary Playwright test profile and normal UI sign-in. Backoffice History shows the quantity matrix above, per-line reasons, two distinct photo links and both signature records for Picking 0101. Picking 0102 shows the exact Customer absent reason and no fabricated signatures. Crew at a 390×844 viewport shows the correct remaining work for both repeat visits, awaits customer confirmation and disables Start visit.

A read-only History Refresh was deliberately answered with HTTP 503. The same pane, selected History tab, reason and visible content were retained. Browser scroll anchoring adjusted the numerical scroll offset when the error banner appeared; after recovery the offset returned exactly to 865.6 px. The error and ordinary screenshots retain the same visible content position. This was an injected read failure, not an actual mobile-network outage or a submission performed through the browser. The write-failure and replay checks are the authenticated HTTP/PostgreSQL tests above.

Local evidence is under `.local/acceptance-browser-demo`: `browser-checks.json`, `chrome-history-partial-lines.png`, `chrome-history-partial-signatures.png`, `chrome-history-customer-absent.png`, `chrome-history-refresh-error.png`, and the two `chrome-crew-followup-*-mobile.png` images. These local-only artifacts are intentionally ignored. Chrome was left on Picking 0102 History and its Crew follow-up. Main counts after the isolated checks remain 27 deliveries, 36 appointments, 19 files and zero published routes.

## Remaining full-stage acceptance

- Physical Android/iPhone camera, Safari, installation as a PWA and actual mobile network loss are not established by this desktop test or simulated response loss.
- Full manual coverage of all four languages and keyboard workflows remains separate from the automated localization and component checks.
- Refusal to sign after an actual handover remains a separate unapproved workflow. Customer absent is a different, verified outcome.
- Fresh current-schema Docker recovery **passed on 12 November 2026** in a separate Compose project, including all 13 main migrations, three databases, private files, signed reports and History. See [recovery evidence and commands](recovery.md#verified-docker-recovery--2026-11-12). Ten test-demo constraints differed only in equivalent AND parentheses and were explicitly reviewed; this was not a data difference. The active stand was preserved. The native-only helper was not used.
- Full offline reporting, real Odoo, paid road APIs and customer/field acceptance are not part of this result. Estimates stay labelled, and no customer acceptance is implied.

The Notion stage 10 card remains **In Progress** until its wider acceptance criteria are met.
