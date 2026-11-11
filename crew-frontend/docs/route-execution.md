# Crew route execution — stages 07–09

11 November 2026. The Crew application now has **My routes** alongside **My visits**. Route screens are Next.js pages with the existing authenticated HTTP proxy, resource refresh behavior, Geist styling and English/Italian/Russian/Uzbek messages. No database connection, extra state library or paid map API was added.

## Crew flow

- `/routes` separates active trips, future published trips and history. An overdue trip in progress remains active. A returned, closed or cancelled route never appears as upcoming just because its planned date is in the future.
- `/routes/:id` shows the current plan version, vehicle/plate, driver, route responsible participant, origin and return destination, approximate schedule and recorded actual events. A changed plan appears in a notice without remounting the entered return note.
- Stops retain their route sequence, customer window meaning, saved unloading entrance and responsible participant. Distinct source lines and orders remain separate even for an identical SKU. **Open visit and work** uses the existing protected visit card, including its exact work, instructions, drawings, checklist, photos and report.
- **We have departed** uses the server's permission and readiness checks. Each visit still needs customer confirmation and the route's next-stop rule. The old visit card links back to its route and explains why Start is unavailable.
- **Start return journey** is distinct from **We have returned**. Actual return can be recorded when the backend permits it even if a report is missing. It requires an explicit physical-return checkbox; the optional note stays intact on Refresh or conflict. Warehouse acceptance remains a dispatcher action, not a Crew checkbox or a side effect of return.
- Amendments, cancellation, resource substitution, dispatcher skips, reconciliation and warehouse receipt remain in Backoffice. Crew sees updated assignment access and state through the live projection; it cannot call these operator endpoints through its proxy.

For uncertain network results, a retry preserves the original request ID, expected route version and actual-return timestamp. A definitive conflict clears that pending command and reloads current data, preserving entered text. Refresh updates data without a page reload; transient failures keep the last read with an error notice, whereas revoked access clears the protected content.

Map buttons are user-initiated external directions links using the saved entrance coordinates when present. They do not make Google API requests from the application. Travel estimates are labelled and never represented as road-derived calculations.

## Contracts and authorization

The frontend validates the consumed part of the backend's `RouteOperationsSchema` in `src/shared/api/route-contracts.ts`. Backend-owned capability flags support presentation; they do not replace server authorization or domain rules. The proxy allows only:

- `GET /api/crew/routes`
- `GET /api/crew/routes/:id`
- `POST /api/crew/routes/:id/depart`
- `POST /api/crew/routes/:id/returning`
- `POST /api/crew/routes/:id/return`

Route commands require JSON and have a bounded 16 KiB body. Only the Crew session cookie is forwarded. Responses are private/no-store; the existing service worker does not save routes, customer details, reports or API responses. Operator routes, arbitrary hosts, unexpected methods and extra path segments are not proxy targets.

## Local verification

Commands from `crew-frontend`:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

The initial implementation passed all four checks and **41/41 tests**. New regressions cover exact same-SKU order lines, lifecycle grouping, server capability display, physical return versus warehouse receipt, retry identity/time, four locales and proxy allowlisting/test-origin isolation. Node's existing `module.register()` deprecation notice is emitted by the installed test toolchain; checks were not suppressed.

Stage 07 was checked in Chrome at a 390 × 844 viewport against the isolated PostgreSQL-backed API on port 3011 on 11 November 2026. The assigned route showed two separate stops and the same-SKU order lines with their exact quantities. The confirmed first visit could not start before departure. Recording departure changed the route to On the road and enabled that first Start; the other unconfirmed visit stayed blocked. Starting the first stop exposed the existing report and checklist controls.

Refresh preserved the selected Upcoming tab, an entered route return note and a visit Work summary. A keyboard-triggered refresh preserved scroll at 738.4 px; the measured page width stayed within the 390 px viewport. The three route tabs were adjusted after the mobile review so the count sits below its label on narrow screens.

Stage 09 was also checked in Chrome at 390 × 844 against the same isolated API. A separate collection route had two completed visits and four exact order lines, each with one collected unit, linked synthetic photos and distinct demo customer/responsible drawings. The reports were submitted through the real authorized HTTP workflow using the backend's `scripts/demo-route-lifecycle-report.ts`; no database or authorization bypass was used. In Crew, **Start return journey** changed the route from On the road to Returning. The entered return note survived that change. Refresh kept both the note and the explicit physical-return checkbox. **We have returned** recorded the actual return and showed Returned · review pending with the separate warehouse-receipt explanation. The route moved to History (Active 0, Upcoming 0, History 1); both completed visits remained under Past visits. Refresh retained the selected History tab.

Operator amendment/cancellation, reconciliation and warehouse acceptance are verified separately through Backoffice and the backend acceptance suite. The Crew return check deliberately sent no warehouse receipt, reconciliation or close command.

Static render tests and a narrow Chrome viewport do not prove behavior on a physical phone. Camera input, physical Android/iPhone PWA installation and a field pilot are separate acceptance work.

## Isolated browser stand

For a separate source copy of this frontend (with its own `.next` output), run:

```powershell
$env:BACKOFFICE_TEST = '1'
$env:CREW_API_ORIGIN = 'http://127.0.0.1:3011'
node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3012
```

The backend must separately allow the exact Crew origin `http://127.0.0.1:3012` in its test configuration. Without `BACKOFFICE_TEST=1`, the proxy only permits the ordinary loopback backend on port 3001; no arbitrary API host is accepted. Use the newest ignored demo connection manifest for the generated participant account. Do not put credentials into this document.

Starting this frontend does not migrate or enable publication on the shared backend. Ordinary `npm run dev` continues to use port 3002 and the configured backend on 3001.

To resume the accepted demo, restart the backend with its existing isolated test database configuration, port 3011, Backoffice origin 3010 and Crew origin 3012. From `backoffice-backend`, use:

```powershell
$env:BACKOFFICE_TEST = '1'
npx tsx scripts/demo-route-lifecycle.ts --resume
```

`--resume` reads `.local/lifecycle-browser-demo/connection.json` and reopens that exact owned namespace, keeping its accounts, routes, reports and return history. Starting the harness without `--resume` creates a new namespace and replaces the latest manifest; it does not continue the displayed demonstration. Read the latest manifest for credentials instead of copying old passwords into documentation. The collection-report helper `scripts/demo-route-lifecycle-report.ts` is only for preparing a fresh collection fixture before actual return; it uses authenticated HTTP and deliberately leaves warehouse receipt and closure to the separate acceptance flow.

The 11 November mobile return screenshot is in the ignored backend evidence directory as `.local/lifecycle-browser-demo/crew-stage09-return.jpg`. The live Crew tab uses port 3012; the ordinary workspace build retains the normal backend origin on port 3001.
