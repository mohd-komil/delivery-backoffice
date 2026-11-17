# Delivery Backoffice — frontend

This standalone project uses Next.js 16.4.4, React 19.3.1, and TypeScript 6.0.3. It communicates exclusively with the neighboring NestJS backend over HTTP. The browser has no PostgreSQL connection or access to server entities.

[visit-work-scope.md](docs/visit-work-scope.md) covers services by product line, selecting operations and quantities when booking, remaining quantities available for planning, and reviewing older visits. It also explains when customers must reconfirm after changes to the work and records the verification results for this stage.

[incomplete-work-history.md](docs/incomplete-work-history.md) covers reasons for partially completed and unperformed work by item in History, original orders, and preservation of earlier reports.

[planning-references.md](docs/planning-references.md) covers shared shifts, breaks and absences, departure and return points, time standards, and applying a specific version of a time standard to a product line.

## Nearby work in Inbox to plan

Opening a delivery from the Inbox automatically loads **Nearby work** within a 10 km radius. Adjust the radius from 1 to 50 km. The backend calculates straight-line distances without the Google API. The list shows the picking, orders, address, remaining operations, quantities, and estimated duration. The selected delivery comes first. Use the checkboxes to add other stops. **Create draft** saves a new draft through the authenticated API, and **Open draft** opens it in Routes.

A draft leaves visits, vehicles, and crews available for booking. The first configured warehouse and the current time are provisional values that the dispatcher reviews in Routes. An unknown duration appears as a clearly labeled 30-minute estimate. A draft holds up to 30 stops. Refresh and changes to the delivery panel tab preserve the radius, selection, and scroll position. Reducing the radius removes work that falls outside it from the selection. Retrying after a network error reuses the same request to prevent duplicates.

[nearby-work-demo.md](../backoffice-backend/docs/nearby-work-demo.md) documents the demo coordinates, repeatable seeding command, and expected distances. The coordinates are synthetic reference points for fictional addresses. They represent neither verified entrances nor geocoded addresses. Straight-line distances are excluded from road travel time calculations.

## Running locally

Install Node.js (verified with 26.13.0) and npm. Start the backend with the local migrations, import, and demo scenario described in its README.

```powershell
cd C:/Users/MOHD/Desktop/backoffice/backoffice-frontend
npm ci
npm run dev
```

Open http://127.0.0.1:3000. Use `127.0.0.1` because the backend checks the origin `http://127.0.0.1:3000` and the cookie is scoped to that local site. The backend creates administrator and operator accounts and stores the fictional local credentials in its **untracked** `.local/demo-accounts.json`. Keep passwords out of the frontend, source code, and reports.

The default API URL is `http://127.0.0.1:3001/api`. To change the port, copy `.env.example` to `.env.local`, update the public URL, and configure the matching allowed frontend origin on the backend. Keep passwords and database URLs out of the frontend `.env.local`.

To build for local production testing, run the following commands.

```powershell
# Stop the frontend server (next dev or next start) before running build or verify.
npm run build

# To run all four checks in order, use verify.
npm run verify
npm start
```

Both servers bind to loopback for local Backoffice testing. Deployment and the Crew frontend are outside this setup.

## Features

- English (default), Uzbek (Latin script), Italian, and Russian. The **Language** selector is available at sign-in and in the header. Next.js reads the saved language from a cookie, and `next-intl` loads messages from `src/i18n/messages/`. Existing URL formats are preserved. Scheduling uses Europe/Rome. Names, descriptions, notes, task snapshots, and source diagnostics display their recorded values.
- Username and password sign-in, an HttpOnly session cookie, and sign-out. Browser storage excludes session tokens from `localStorage`.
- Eight delivery views with server-side counts and pagination. Issues and returns can overlap with progress states.
- The ⓘ icon beside a heading explains the screen and how to get started. The tooltip opens on hover, keyboard focus, or touch and reflects the selected delivery status or directory tab.
- A customer record, a source picking with one or more sales orders, each product line's order, and canonical completed quantities from the backend. Unknown fields are shown explicitly.
- Local instructions, multiple visits, multiple crews per visit, participant and template snapshots, rescheduling and cancellation with a reason, required checklists, and operator waivers with a reason.
- After assigning a crew, **Awaiting customer confirmation** appears in the visit panel, calendars, and Visit staffing. An administrator or operator records the customer's consent under **Visits & tasks → Record customer confirmation**. Rescheduling requires new consent and keeps the previous record in History. Chrome verification, all 78 frontend tests, type checking, typed linting, and the build passed.
- The Starts at and Ends at fields in booking and rescheduling use native date and time controls. The frontend interprets input in Europe/Rome regardless of the computer's time zone and sends canonical UTC ISO values to the API. The missing spring hour is rejected. The repeated autumn hour requires an explicit occurrence with its UTC offset. Rescheduling preserves the original occurrence, seconds, and milliseconds.
- A Europe/Rome day and week calendar with a visit list and parallel resource columns. The axis shows elapsed minutes since local midnight. DST days have 23 or 25 hours, and the repeated hour displays its UTC offset.
- A standalone Participants directory with first name, last name, preferred name, phone, address, external status, and enabled status. Unknown fields on migrated profiles are blank. Administrators and operators can create, view, edit, disable, and delete unused profiles. Both roles can manage Crew sign-in credentials. A new username requires a new password of 15–256 characters. The API keeps passwords private and the UI leaves the field blank. Leaving the new-password field blank preserves the current password.
- Crews store a default roster of existing participant IDs. A roster can be empty. A participant can be on at most one default roster, including disabled crews. Visit assignments can use other available people. Visit staffing shows the date, actual participants, and one form for all crews on the visit. Moving a participant between crews saves atomically with a reason and version. Busy or disabled people are unavailable for new assignments, with the reason for availability conflicts shown. A previously assigned disabled person can remain only with the original crew. The backend rechecks the assignment rules and availability conflicts. Recorded work snapshots are preserved.
- The Skills section under DELIVERY VIEWS includes a dynamic catalogue and a Participant skills tab. Administrators and operators can create, edit, disable, and delete unused skills, and assign skills to participants. Skills are editable in the full participant profile. Task templates define required skills. Each assigned participant must have every required skill. The checks use the visit's selected participants, including overrides.
- The Vehicles section below Skills includes a dynamic catalogue of physical company and external vehicles and separate transport allocations per visit. Administrators and operators can manage the catalogue, check availability, and add, replace, or cancel allocations. The history is preserved.
- Issues and resolutions, notes, repeat visit requests, related photos, and links from requests to new visits. A planned request keeps its own status until resolved.
- Private documents and photos support PDF, PNG, JPEG, and plain text uploads of up to 5 MiB. Downloads use authenticated delivery-scoped URLs. Pending or damaged files appear as unavailable. The backend independently verifies type, contents, size, and associations. Retrying the same upload reuses the same request ID.
- Crew result review, demo signatures and refusals, separately versioned corrections, immutable source, instruction, and assignment snapshots, and history. Closing a delivery requires an explicit verification command. Reopening it requires a reason.
- Loading, empty, error, and retry states, with messages for permissions, stale versions, conflicts, source review, and closure blockers. Zod validates known HTTP responses before the UI confirms success.
- Geist Sans and Mono from the local npm package, Tailwind 4, local shadcn-style primitives, Radix dialogs, and light, dark, and system themes. See `docs/design-system.md` for design decisions.

This application handles Backoffice work. Authenticated backend demo scenarios submit results using the shared domain rules. Crew screens, the mobile client, signature capture, and public endpoints that could impersonate crews or customers are outside this application.

## Route drafts

Open [Routes](http://127.0.0.1:3000/?section=routes) after signing in. Create a draft, enter the departure time in Rome time, select the departure and return warehouses, and optionally pick a crew and vehicle. Add addresses from **Nearby work**. Remaining-work rows show delivery, assembly, and collection separately, with the original order.

Use **Move up** and **Move down** to reorder stops, then enter the work duration in minutes. **Route timeline** recalculates arrival, work start and end times, waiting, and return. Demo addresses use travel times from a demo matrix. Enter travel times manually for the other legs. Saving a draft leaves visits, crews, and vehicles available for booking.

When Google Maps is configured, the map shows warehouses, numbered stops, and a road route line. If a stop has no map point, enter its latitude and longitude in **Stop coordinates**. The pin is saved with the draft and needs review after an address changes. Each leg in the schedule shows its estimate source. Manual travel times override Google estimates. See the [backend README](../backoffice-backend/README.md#google-maps-on-the-local-stack) for setup instructions.

To save an unloading entrance for future visits, open **Review unloading entrance** at a stop in **Routes** or under **Delivery details → Overview**. Review the suggested point. Select an independently verified entrance on the map or enter its coordinates, confirm the selection, and save. Routes uses the confirmed point ahead of draft coordinates. Changing the entrance updates the route and preserves entered fields.

The [MVP scenario](../backoffice-backend/docs/mvp-pilot.md#multi-stop-route-draft) lists the verification data for two synthetic pickings and the expected values.

## Vehicles and multiple orders (2026-11-04)

Sign in to Backoffice and open [Vehicles](http://127.0.0.1:3000/?section=vehicles), directly below Skills in the navigation. Administrators and operators can search, filter by ownership or status, create, view, edit, disable, and delete unused records. A physical vehicle has a name, license plate, company or external ownership, operational status, an Enabled flag, and notes. An external vehicle requires a provider name and can optionally have a contact. License plates are converted to uppercase and trimmed, preserving internal spaces and hyphens. Crews and vehicles are allocated per visit.

1. Open the delivery, go to **Visits & tasks**, book a visit, and assign its actual crews, participants, and tasks.
2. Select **+ Allocate vehicle** on the visit. **Reserved from** and **Reserved until** default to the visit interval and use the shared Rome date and time picker. Extend the interval to allow for loading, travel, and return. **Check availability** checks that exact interval. Changing the times requires a fresh check before saving.
3. Choose an available physical vehicle and, when needed, a participant driver or an external driver with a name and phone number. A participant driver can be outside the crew or serve as both driver and crew member. Entering an external driver's name records the name only. Availability requires manual confirmation.
4. Add more vehicles if needed. Use **Replace** for a breakdown or **Cancel** to release a reservation. Both actions require a reason. History retains earlier records, actors, timestamps, and reasons. A repeat visit has its own transport allocation and can use a different crew and vehicle.

The reservation interval must cover the entire visit, have a positive duration, and span at most 45 days. Busy or disabled vehicles, vehicles in maintenance or out of service, and busy or disabled participant drivers are unavailable. The UI shows the reason and the overlapping interval, when applicable. A physical vehicle can have only one active allocation for the visit, and a participant driver can drive only one vehicle actively allocated to it. When a participant both drives and joins the crew on the same visit, the two roles are compatible, and the transport interval extends their occupied time. The backend independently checks the resources, version, and request ID.

Transport can change only for an unstarted, booked visit on an open delivery. Previous allocations can still be replaced or canceled if the visit currently has no crew. To reschedule, explicitly cancel active transport, move the visit, and allocate transport again. Completing work at the customer's location keeps the vehicle or participant driver reserved through the reserved return window. Disabling a vehicle or marking it for maintenance keeps existing reservations in place. Refreshing the delivery panel shows the current vehicle warning and preserves the recorded name and history. New execution results include the transport recorded at the time of work. Legacy results without this field omit transport.

Refreshing Vehicles preserves the filters, table, and open draft. Refreshing the delivery or availability preserves the interval, selected vehicle, driver, reason, tab, and scroll position. Late responses cannot overwrite current ones. The catalogue editor retains the original version and shows a 409 error while preserving input. The transport form checks the delivery version and provides an explicit **Use latest data** action. Retrying an unchanged command after an uncertain outcome reuses its request ID. Changing the request data creates a new request ID.

Each delivery corresponds to a picking, which can include several sales orders. The list and delivery panel show all available sales orders. Product lines, issue choices, and file choices identify their order. New imports include the full `salesOrders` and `items[].saleOrderId`. Older records use the legacy primary reference. An unknown line-to-order association is indicated explicitly. Historical results use the recorded source snapshot. The integration has read-only access to Odoo and reads existing sales orders. See [vehicles.md](../backoffice-backend/docs/vehicles.md) and [source-model.md](../backoffice-backend/docs/source-model.md) for domain and API rules.

Verification at this stage passed `npm run typecheck`, the full `npm run lint`, **73/73 tests**, and the production `npm run build`. The production frontend was rebuilt and restarted. Eleven new DOM and contract regressions cover the catalogue and roles, provider and license plate, captured version, request ID reuse on retry, busy resources, a separate driver, a manual reservation interval and the 45-day limit, replacement and cancellation, an unstaffed visit, a maintenance warning with a preserved draft, and several orders. Component tests use HTTP fixtures. The read-only API smoke test passed **1/1** after rollout. Browser verification created an external vehicle and a visit for picking 20, assigned the crew, vehicle, and driver, recorded a demo breakdown, and saved a replacement with a reason. Refresh, the form, and the table were verified at 320 px. See the [vehicle catalogue](docs/screenshots/vehicles-catalog.jpg), [replacement history](docs/screenshots/visit-transport-replacement.jpg), and design system notes.

## Skills workflow

1. Open Skills under DELIVERY VIEWS. In the Skills tab, administrators and operators can use **New skill** or **Edit skill** to set a name, an optional description, and the Enabled flag. The catalogue loads from the HTTP API. New skills require no frontend code changes. Use the search, status, and participant count to find a record.
2. In Participant skills, find a person and select **Edit skills**. One versioned command saves all selected skills and changes only that participant's skills. The same selection is available in the full Participants form. An existing disabled skill assignment can be retained or removed. Disabled skills are unavailable for new assignments.
3. In Task templates, select **Required skills for every participant** and save the template with one command. Every participant assigned those tasks must have all the selected skills.
4. When assigning a visit, select crews and tasks, then select the actual participants. Tasks stay selectable so an unsuitable default roster can be replaced. Ineligible new participants are unavailable and display **Missing skills** and the required skill names. A conflicting participant already selected stays in the form and can be removed. Save becomes available once the roster is valid. Qualifications are checked for each person individually.

The same checks apply when editing the staffing of a booked visit through Visit staffing. Requirements come from the recorded visit tasks. Participant skills and the Enabled flag come from the current catalogue. A disabled required skill blocks new assignments and changes to planned staffing. Start, execution, and rescheduling use the roster already recorded.

Refreshing Skills preserves the tab, search, status, table, open editor, scroll position, and input. The editor works with the record's original version even if the server record changes. The form shows a 409 conflict. Refreshing the visit panel and availability reloads current participant skills while preserving selected participants for review or removal.

New assignments capture required skill names and participant skills in snapshots. Historical skill badges use `requiredSkillsSnapshot` exclusively, so renaming a skill leaves earlier tasks unchanged. A legacy task without this field has no recorded requirements. The public participant calendar profile omits `skillIds`, `login`, and `hasPassword`.

Verified on 2026-11-04. Frontend type checking, full typed linting, **62/62 tests**, and the production build passed. The production frontend was restarted. Eleven new tests cover CRUD, roles, versions, Refresh, the participant profile and the scoped skill update, template requirements, each participant's qualifications, actual roster overrides, disabled skills, and historical names. The updated read-only API smoke test passed **1/1** against the Docker backend. The backend also passed type checking, linting, the build, and **95/95 tests**. The skills migration was applied to the main and test databases after a fresh Docker backup and an independent check that previous records and history were preserved.

Desktop browser verification confirmed that Skills appears under DELIVERY VIEWS, the catalogue loads, and the seventh skill, `Heavy lifting`, could be created. Participant skills saved and reloaded the same two skills for Antonio, heavy lifting and product checks. Refresh preserved the Participant skills tab, the Antonio search, and the Enabled status. The example with six skills for Simone and the furniture assembly skill requirement for Assemble was prepared through explicit API commands. Existing visits were preserved.

For the final mobile check, the viewport and document measured exactly 320 CSS px. Skills remained accessible through the sidebar's horizontal scroll. The participant table had a client width of 278 px and a scroll width of 700 px, with overflow contained in the table. The dialog measured 293/293 px and the fieldsets 237/237 px. Refresh preserved page Y=0, table scrollLeft=376.7999878, the Antonio search, status=enabled, and the Participant skills tab.

The standard 1280×720 viewport was restored after verification, with a 1280 px document width. In Light, visual checks confirmed the white surface `rgb(255, 255, 255)` and text `rgb(23, 23, 23)`. Selecting System restored Dark. Verification was limited to the observed theme states and those two colors. Console warnings and errors were `[]`. The [Participant skills screenshot](docs/screenshots/participant-skills.jpg) shows the desktop view with Skills under DELIVERY VIEWS, the Simone filter, and six badges.

Skills browser QA used existing bookings. At the time of verification, operational appointments were canceled or completed. Assignment rules were verified in the backend suite (**95/95**, including real HTTP and PostgreSQL checks) and the frontend suite (**62/62**, including UI regressions).

## Verification

```powershell
# Stop the frontend server before running build or verify.
npm run typecheck
npm run lint
npm test
npm run build

# Run after starting the backend, importing 20 pickings, and running the demo scenario.
npm run test:api
```

`typecheck` and `build` remove only their own generated `.next/dev/types` after the development server has stopped, then create fresh route types. This prevents duplicate `LayoutProps` when Next 16 development and build caches coexist. Source files, tests, and scripts remain subject to strict checks with `skipLibCheck: false`.

`npm test` covers complete and migrated profiles, administrator and operator UI, blank password fields, roster selection by ID, initial assignment overrides, atomic participant transfers, busy and disabled participants, staffing draft retention and version checks, Rome and DST behavior, required offsets, week boundaries, adjacent and overlapping visits, and the 23- and 25-hour layout. `npm run test:api` reads local demo credentials within the process, obtains a real session, and verifies client contracts for all 20 deliveries, completed results and signatures, directories, import, calendars, and private downloads including 401 and 404 responses. It resaves the current instructions for one open picking with the same values and records the operator audit event. For a read-only smoke test of business data, run the following commands.

```powershell
$env:BACKOFFICE_READONLY_SMOKE='1'
npm run test:api
Remove-Item Env:BACKOFFICE_READONLY_SMOKE
```

Override the accounts file path with `BACKOFFICE_DEMO_ACCOUNTS`. The test creates and ends its own session cookie without printing it.

All Refresh and Retry buttons update data in the background. Loaded tables, calendars, panels, selected tabs, expanded sections, scroll position, and input remain mounted during a request. On error, the last result remains visible. Canceled or delayed responses cannot overwrite newer ones. When a record version changes, the draft stays available and cannot overwrite newer data. The operator can review and explicitly select **Use latest data** to reset that form. Retrying a save after an uncertain outcome reuses its request ID. An explicitly new draft receives a new ID.

`npm test` also runs seven Refresh DOM regressions through jsdom and React `act` on real components, covering DOM and form retention, scroll position, errors, request races, and retry. Nine additional checks cover profiles, default rosters, unavailable staff, initial assignment, and atomic transfers. A further nine unit and component checks cover date and time selection, winter and summer offsets, DST gaps and folds, independence from the computer's time zone, and precise rescheduling. Component tests use validated HTTP fixtures. Real API authorization has its own verification. At the date and time picker stage, **31/31 frontend tests**, type checking, typed linting, and the optimized build passed via `npm run verify`.

After rebuilding and restarting the production frontend, all five Refresh buttons were checked in an authenticated browser across deliveries, calendars, directories, delivery details, and import history. The list page, tabs, filters, expanded sections, selected file, input, and scroll position were preserved. Crews use a compact Geist table whose horizontal scrolling still works at 320 px. The verification left test drafts unsubmitted. Component tests additionally cover HTTP errors and races. See `docs/design-system.md` for observations and verification scope. Customer Odoo and production deployment remain unverified.

On 2026-11-03, `npm audit --omit=dev` reported zero vulnerabilities. The full audit reported development dependency advisories involving minimatch/ESLint and esbuild. The audit was report-only and kept the existing dependency versions. ESLint 9.39.5 was selected for compatibility with the plugins bundled in eslint-config-next, which had yet to declare ESLint 10 support. npm marks ESLint 9 as deprecated. Node 26 also reports tsx warning DEP0205 during checks. These warnings remain visible.

After normalizing participants, the complete `npm run verify` passed type checking, typed linting, 22 tests, and the optimized build. The live read-only API smoke test also checks profiles, default roster references to real participant IDs, and availability for a recorded visit. An authenticated browser created the explicitly fictional `DEMO Flex Worker` with contact fields and no sign-in credentials. It verified assignment outside the default roster, a transfer between crews in one save, blocking a busy participant with the conflicting interval, and assignment to the next nonoverlapping shift. The local demo bookings remain on 10 November 2026, `DEMO/OUT/0002` from 09:00–11:00 and `DEMO/OUT/0003` from 11:00–13:00 Europe/Rome, with their audit entries available for review. Existing assignments were preserved. See the [visit staffing screenshot](docs/screenshots/visit-staffing.jpg).

The native date and time picker was checked in an authenticated browser. A visit for `DEMO/OUT/0004` was booked for 13 November 2026, 09:30–11:00 Europe/Rome, then canceled with the reason `DEMO date-time picker verification completed; temporary booking cancelled`. The temporary visit is inactive, and its creation and cancellation remain in the audit trail. Refresh preserves the entered date and time and the scroll position. See the [date and time picker screenshot](docs/screenshots/appointment-date-time.jpg). The picker changes were confined to the frontend. The full suite passed **69/69 tests** at this stage.

## Inbox geographic filters

Inbox to plan supports dependent City, Province, and Postal code (CAP) filters. Cities cover the entire Inbox. Provinces reflect the selected city, and postal codes reflect the selected city and province, across all pages. Changing the city clears the province and postal code. Changing the province clears the postal code. Outdated dependent options are unavailable until the new response arrives. **Not provided** matches records with no value. **Clear filters** restores the full list and first page. Refresh preserves the filters and open delivery panel. Other delivery views begin without the Inbox criteria. The table and map use the same query, and the backend filters before pagination.

Auto-selection works in both directions. Start with City, Province, or Postal code. An explicit selection fills other empty fields only when there is exactly one known value among all matching deliveries. For example, CT fills Catania, and 95121 fills Catania and CT. Multiple choices require manual selection. **Not provided** is excluded from auto-selection. **Clear filters**, manually selecting **All**, and ordinary Refresh leave auto-selection idle. Selecting Catania fills CT and leaves CAP open because two postal codes are available. The companion values come from `matchingGeographyFacets` independently of the dropdown options and table pagination.

The city comes from the imported snapshot. Demo provinces and postal codes are stored separately and apply only to the same customer and address. The feature uses local data. See [geography-demo.md](../backoffice-backend/docs/geography-demo.md) for seeding, constraints, and expected results. Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` for automated checks. The regression is in `test/inbox-geography.test.ts`.

## Operational delivery list filters

In **Planned**, **Assigned**, **In progress**, **Partially completed**, **Return visit required**, **Issues**, and **Completed**, search by customer name, picking number, or any linked order number. All seven views support city, province, and CAP filters. **Planned** filters by visit date. The other views also offer team selection. In **Completed**, the date range applies to the closure date. **Issues** offers the type of open issue, and **Return visit required** offers the status of an outstanding request.

Search, team, and view-specific filters are immediately visible. **More filters** reveals the date range and geography and shows how many conditions in the panel are active. Only applied conditions appear below the panel. Remove any condition separately, or clear city, province, and CAP together using the **Location** chip.

Cities, provinces, and CAP values come from all addresses imported into Backoffice. Teams come from the directory and assignment history. Options remain visible when a delivery view is empty. The count in parentheses shows the number of matches in the current view. `0` indicates an available option with no current matches. Selecting a city or province narrows the other geographic fields to compatible options.

Date ranges include the selected calendar days in Europe/Rome. In views where both team and visit date apply, they must match the same visit. In Completed, the team comes from completed visits. All filters apply before pagination into pages of ten deliveries. Sidebar counts continue to cover the full view. **Refresh** updates the data and preserves the page and filters. **Clear filters** removes the criteria and returns to the first page.

See [demo delivery view filters](../backoffice-backend/docs/delivery-view-filters.md) for the local verification scenario.

## Inbox map

The **List / Map** toggle uses the same city, province, and postal code filters. The map requests all matching deliveries through `GET /deliveries/map`, independently of table pagination. A single marker opens the existing delivery panel with Nearby work. A numbered marker reveals several deliveries at the same coordinates. Deliveries without coordinates appear separately with working links to their panels.

The local demo uses Leaflet 1.9.4 and an OpenStreetMap basemap without Google API keys. The basemap requires internet access, and the backend supplies delivery data. Demo coordinates are synthetic reference points. A confirmed entrance takes priority over a demo point. Refresh and switching between List and Map preserve zoom and position. Changing the filters displays all matching points. **Show all points** fits the map to the results. The delivery list below the map remains usable if the basemap fails to load.

Tiles load when the map opens, with attribution and standard browser caching. Regions are loaded on demand. The public OSM server is suitable for this small interactive demo. Before increasing traffic, select an appropriate provider or run a tile server according to the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/). The map displays points without calculating road routes or ETAs.

`npm test` includes `inbox-map.test.ts` for requests, filters, and the delivery panel. `inbox-map-canvas.test.ts` uses real Leaflet in jsdom for marker selection, overlapping points, keyboard interaction, Refresh, tile errors, and cleanup. These tests supplement the browser verification in [design-system.md](docs/design-system.md).

## Participant calendar

Select a name in Participants to open the read-only `/participants/[id]/calendar` page as a Backoffice administrator or operator. The calendar shows visit dates and times, picking and customer, status, actual crew, and the participant's recorded tasks and checklist. It loads data through `GET /api/participants/:id/calendar?from=<ISO>&to=<ISO>`. The API matches the UUID in the actual assignment independently of the default crew roster or name. Completed and canceled visits are available for historical review, and repeat visits are marked separately. Crew tasks share the visit interval.

The projection omits `login`, `hasPassword`, results, signatures, and files. The feature uses the existing database schema and is available in Backoffice. The backend passed **76/76 tests**, type checking, typed linting, the build, and OpenAPI generation. See the [participant calendar screenshot](docs/screenshots/participant-calendar.jpg).

The final `npm run verify` rerun passed **38/38 frontend tests**, type checking, typed linting, and the optimized build, including the dynamic calendar route. Seven new component checks cover snapshots, Rome and DST behavior, both visit times, Day and Week, canceled, empty, and error states, Refresh and request races, an open delivery draft, and runtime validation. Live read-only `npm run test:api` passed **1/1** with an active operator session and the new endpoint.

In the production browser, selecting Simone in Participants opened the participant calendar. On 10 November, it showed Catania Uno from 09:00–11:00, Assembly Studio from 11:00–13:00, and Check products. Both times were visible on each card. Refresh preserved the date, Day mode, canceled-visit preference, and internal scroll position. At 320 px, overflow stayed within the calendar. **Open delivery** opened `DEMO/OUT/0002`. A note survived Refresh and the panel was closed with the note still unsaved. An uppercase UUID still resolved to the correct participant, and **Back to Participants** restored the tab. Business data was preserved, the viewport override was removed, and there were zero browser console warnings or errors. Both local production servers were running. See `docs/design-system.md` for measurements.

## Month view in calendars

The 13 November 2026 update added City, Province, Postal code (CAP), Team, and partial customer name search to the main Calendar. Address options cover **all loaded deliveries**, and teams cover the **full directory**, including teams without visits in the selected period. Changing the date or customer search leaves available choices intact. Geographic fields work together as in Inbox. A city narrows provinces and postal codes, and an explicit selection fills the only known option when one exists. Counts beside addresses cover deliveries across the database. The count above the calendar covers visits in the selected period.

Calendar filter options load independently through `GET /api/calendar/filter-options`. Visits still use `GET /api/calendar`. The five filters apply together to the grid and table in all modes. The team matches the ID of an actual visit assignment. Options include **Not provided** and **No crew assigned**. Refresh and Day, Week, and Month navigation preserve the selection. An empty period leaves team and address options available. A directory load error appears explicitly. The shared shadcn Combobox shows search only when it has more than five options.

Verification passed frontend type checking, full typed linting, the production build, five model tests, six UI tests, 14 Calendar, Refresh, and pagination regressions, and 17 existing Inbox geography tests. The backend passed type checking, typed linting, the Docker build, and 21 focused tests on isolated PostgreSQL. Chrome verified combined filters, reverse auto-selection, selection and input retention across Refresh and period changes, light and dark themes, and a narrow screen. The full directory in the test environment covered 790 deliveries, 143 known cities, and six teams. An empty December period and a customer search with no match left all available choices intact. Business data was preserved during verification.

The local customer-schema environment exposes [Calendar](http://127.0.0.1:3030/?section=calendar) and API `http://127.0.0.1:3031/api`. The build for this verification is in `.local/odoo-integration/frontend-people-operator-20261113`. Start it there with `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3030`. Rebuild with `NEXT_PUBLIC_API_URL=http://127.0.0.1:3031/api` and `npm run build`. The ignored `.local/odoo-integration/frontend-runtime.json` records the active PID and command.

Since 16 November 2026, [Crew on port 3032](http://127.0.0.1:3032) has shared backend 3031 and its application data. Chrome verified that MTO/OUT/00697, assigned in Backoffice, is visible to DEMO Person 1 in Messina Uno with the date, vehicle, collection scope, and pending customer confirmation. Both apps read the assignment directly from backend 3031. See the [Crew README](../crew-frontend/README.md) for launch instructions and the private demo sign-in file.

Both the main calendar and participant calendar use the same Day, Week, and Month controls, Previous, Today, and Next actions, and month picker. Month shows four to six complete weeks from Monday to Sunday, including dates from adjacent months. Moving to another month clamps the selected day to the last valid day, accounting for leap years and Europe/Rome DST. Selecting a date or **+ more** opens Day. Selecting an event opens its delivery panel. Refresh preserves the mounted month grid, view and month, filters, and scroll position.

Both calendar APIs accept up to **45 days**, covering a six-week grid and the extra hour during the autumn DST transition. The previous limit was 32 days. Strict ISO and offset rules and half-open overlap semantics still apply. Backend Month verification passed **77/77 checks**, type checking, typed linting, the build, and OpenAPI generation. The implementation uses the existing tables and dependencies in Backoffice. See [Calendar Month](docs/screenshots/calendar-month.jpg) and [Participant Month](docs/screenshots/participant-calendar-month.jpg).

The final Month `npm run verify` passed **47/47 frontend tests**, type checking, typed linting, and the optimized build. Live read-only `npm run test:api` passed **1/1** with an active operator session and complete 42-day requests for both endpoints. The local production API and UI were restarted.

In the browser, the participant Month view for November 2026 showed 42 dates from 26 October to 6 December, marked 3 November as today, and showed Catania Uno from 09:00–11:00 and Assembly Studio from 11:00–13:00 on 10 November. Previous, Next, opening Day from a date, and Refresh were verified. The view, month, canceled-visit preference, and scroll position were preserved. The main Month view showed six recorded events, including completed ones, and supported Next, Today, and opening `DEMO/OUT/0002`. Refresh preserved the table, November, and the page scroll position. At 320 px, overflow stayed inside each calendar. The final browser console had zero warnings or errors. Business data was preserved and viewport overrides were removed. The participant calendar remained open in a standard 1280 px tab. Both screenshots were saved. See `docs/design-system.md` for measurements.

## One default crew roster per participant

A later clarification established that one participant UUID can belong to zero or one default crew globally, including disabled crews. The Crews administrator editor grays out participants from other crews and names their current crew below their name. The current crew's participants can be retained or removed. If Refresh reveals a conflict between the draft and another crew, the conflicting selection can be removed. Save is blocked until the conflict is resolved. The backend independently returns a 409 with the participant and crew names and protects the rule with a transaction and a PostgreSQL `UNIQUE` constraint.

The rule applies to default rosters. Visit staffing can still select an available participant for another crew on another visit, and it preserves the snapshots. The user chose to keep Antonio in Messina Due, Alessandro in Catania Uno, and Andrea in Catania Due. A single administrator PATCH moved Assembly Studio from v10 to v11 by removing just those duplicates. Its default roster is now empty. Other crews were preserved. The guarded migration was applied to the main and test databases after a backup. See `docs/people-and-staffing.md` in the backend.

Verification passed **51/51 frontend tests**, type checking, typed linting, and the build. The backend passed **80/80 tests**, type checking, typed linting, the build, and OpenAPI generation. The live read-only API smoke test passed **1/1**. This work uses the existing tables and dependencies in Backoffice.

A fresh production-browser check confirmed that Assembly Studio had zero participants and the other five crews each had three. **New crew** showed Alessandro, Andrea, and Antonio as unavailable with their respective reasons, **Already in Catania Uno**, **Already in Catania Due**, and **Already in Messina Due**. The available Simone could be selected and deselected. In Catania Uno, its own member Alessandro was selected and could be removed and restored while Save remained available. Busy participants from other crews stayed unavailable. The verification left the edits unsaved. At 320 px the editor fit its area. The viewport override was removed and the console had zero warnings or errors. The backend rerun after the test database migration passed **80/80**. The repeat read-only smoke test after restarting services passed **1/1**. See the [crew membership screenshot](docs/screenshots/crew-membership.jpg) and the design system for measurements.


## Delivery list and geographic area (2026-11-09)

Visit booking and staffing filters (2026-11-10): [behavior, validation and launch commands](docs/visit-planning-ui.md).

Participants, Crews and Task templates CRUD: [permissions, deletion rules and checks](docs/directory-crud.md).

Operator CRUD extended on 2026-11-13: Francesca can create, edit and delete Participants, Crews and Task templates, including participant skill assignments. Full frontend typecheck, typed lint, production build and 51 focused tests passed; backend checks and 41 isolated PostgreSQL tests passed. Chrome verified all three sets of forms and delete confirmations under Francesca on the rebuilt customer-development stand. Existing browser records were not changed. Current checks and launch instructions are in the linked directory document.

Skills and Vehicles also support complete CRUD. Click a record name to open its read-only details, including the current version; both administrators and operators can create, view, edit, disable and delete records in these two catalogs. Administrators and operators also manage Participants, Crews and Task templates, including participant skill assignments and Crew login/password configuration. This does not grant access to Backoffice user roles or reveal stored passwords. Delete uses the same confirmation dialog and success toast as the other directories. It sends the loaded version, retains the row on conflicts and preserves filters and pagination while refreshing the list. Skills assigned to participants or required by templates, and skills or vehicles referenced by planning/history, cannot be deleted; disable them instead. Unused records can be permanently removed after confirmation. No source data in Odoo is changed.

Verified on 2026-11-13: frontend typecheck, full typed lint, production build and 37 focused directory/skills/vehicles tests passed. The backend passed 39 focused HTTP/PostgreSQL checks plus its typecheck, typed lint and build. Chrome on the customer-development stand confirmed the operator's read-only skill and external-vehicle details, seeded catalogues and vehicle search retained through Refresh. Admin deletion and conflict flows were exercised by automated UI and authenticated HTTP tests. Eight skills and five fictional vehicles were added through the API; a second seed run created none. Existing records were retained. [Skills](http://127.0.0.1:3030/?section=skills) · [Vehicles](http://127.0.0.1:3030/?section=vehicles).

All record tables use shared pagination with 10 rows per page: [scope, Refresh behavior and checks](docs/table-pagination.md).

Inbox and the other delivery tables show operational status, active crews/visit dates and provisional remaining work. On Inbox Map, **Use visible area** applies the visible rectangle to both List/Map; **Clear area** preserves City/Province/CAP. Details and browser evidence are in [design-system.md](docs/design-system.md#delivery-list-planning-summary-and-geographic-area--2026-11-09).

Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` for local checks. With the Docker API running and the existing local demo manifest available, run the read-only live check: `node --import tsx --test test/section-two.smoke.ts`. Start the built frontend with `npm start` at http://127.0.0.1:3000. No Google API is used by the area filter.

## Product problems, documents and route feasibility (2026-11-11)

Issues & returns now links Crew product problems to exact order lines and requires an operator explanation to release damaged remaining work. History preserves the report's instruction/drawing version; Files can add a new immutable version. See [readiness rules and the completed Chrome demo](../backoffice-backend/docs/product-issues-readiness.md). `DEMO/FOLLOWUP/0001` contains two orders sharing a SKU, distinct line photos/reasons, synthetic signatures and an explicitly released damage hold. Its Issue remains open and its signed report still references instruction v2 after v3 was uploaded.

Routes checks the selected remaining work, customer window meaning, actual participants, driver, vehicle, date-specific working intervals and breaks through the return journey. Missing information is shown explicitly. Stop-order suggestions compare the same approximate travel basis and require Apply; Undo restores the previous order. They do not publish or book a route. See [constraints, demo and checks](../backoffice-backend/docs/route-feasibility.md). `DEMO · Catania route feasibility` compares 18 versus 15 travel minutes and 10:53 versus 10:50 return, without Google API.

Typecheck, typed lint and production build passed. The complete frontend suite passed 186 tests; five subsequently added readiness/resource regressions also passed. Chrome verified report/history, readiness release, document replacement, and route proposal/apply/undo. Physical-phone acceptance remains unverified: computer control stopped when it could not reliably determine Chrome's active URL. This is local verification, not customer acceptance.

Run the existing Docker backend first, then `npm run build` and `npm start` in this project. Crew runs independently at http://127.0.0.1:3002; launch instructions remain in its README. Refresh keeps current form drafts while updating data. Screenshot: [product checks in History](docs/screenshots/operations-followup-history-20261111.png).

## Route publication review

Stage 06 UI, capability gate, exact work, Refresh behavior and verification: [route-publication.md](docs/route-publication.md).

## Published route operations

Stages 07–09 add live route status, reviewed amendments, cancellation, factual return, exact-line reconciliation, warehouse receipts and independent route closure. See [route-operations.md](docs/route-operations.md) for behavior, isolated launch instructions and Chrome verification.
