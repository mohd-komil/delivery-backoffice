# Delivery Backoffice backend

Tasks 14, 16, and 17 cover [previously completed work](docs/prior-work.md), [repeat-import reconciliation](docs/source-reconciliation.md), and the [dispatcher decision queue](docs/dispatcher-queue.md). The [shared planning reference data](docs/planning-references.md) covers shifts and absences, departure and return locations, standard work times, and how they feed into Routes.

November 13, 2026. The `delivery-odoo-customerdev` stack was upgraded to 19 migrations. Backoffice runs at `http://127.0.0.1:3030` and the API at `http://127.0.0.1:3031/api`. All 790 deliveries retained their original JSON. The upgrade made no writes or repeat imports against Odoo. Backend verification passed all 374 tests on isolated PostgreSQL, strict typecheck, typed lint, and build. [Interface checks, backup, and restart commands](docs/planning-references.md#final-verification-and-runtime--2026-11-13).

Stage 10 covers the [end-to-end checks for two pickings, partial delivery, Customer absent, retries, and remaining work](docs/stage10-acceptance.md). The document records expected quantities, test results, commands for a separate demo, and the remaining acceptance criteria.

November 12, 2026. The [restore of a fresh Docker backup to a separate stack](docs/recovery.md#verified-docker-recovery--2026-11-12) was verified against the 13 migrations applied at that time. The restore included all three databases, files, signed reports, and History. The main stack was preserved. The restored API health endpoint is `http://127.0.0.1:3021/api/health`.

Stages 07–09 added published routes in Crew, departure, amendments and cancellation with history, actual return, outstanding-work review, and separate warehouse receipt. See the [contracts, limitations, and demo setup](docs/route-lifecycle-implementation.md). Route closure, picking closure, and warehouse receipt are separate actions.

Participants, Crews and Task templates: [CRUD API, deletion rules and verification](docs/directory-crud.md).

Line-level services, work and quantity selection in Book appointment, reservations for outstanding work, and follow-up visits are covered in the [contract and verification](docs/visit-work-scope.md).

Crew reasons for incomplete work by line and operation, History, and corrections are covered in the [contract and verification](docs/incomplete-work-reasons.md).

Route publication is described in the [Task 05 contract](docs/route-publication.md) and the [Stage 06 implementation, activation limits, and test setup](docs/route-publication-implementation.md). Publish is implemented and defaults to off until departure, cancellation, and actual return are available.

This local NestJS, TypeORM, and PostgreSQL demo backend follows the [Notion plan v0.2](https://app.notion.com/p/40c4433fac0f815ab7e5fb9257f22047). Fake Odoo uses a synthetic schema. The customer schema remains unverified.

## Fake Odoo demo stack with Docker

Compose runs the backend and PostgreSQL with the `delivery_backoffice`, `delivery_backoffice_test`, and `odoo_mock` databases. Start the frontend separately on the host. Data already transferred to this stack needs no further seeding.

```powershell
./scripts/docker-configure.ps1
docker compose --profile importer up -d --build
docker compose ps -a
```

The API is at `http://127.0.0.1:3001/api`, and local SQL clients can reach PostgreSQL at `127.0.0.1:55433`. The database and private files use named volumes. The [Docker runbook](docs/docker.md) covers migration, fresh-stack setup, testing, imports, and returning to the saved native cluster. The ignored `.local/docker/secrets` directory holds secrets outside the images. PostgreSQL and the API bind their published ports to loopback only.

## Alternative native setup

This setup requires Node.js 24.11+ (verified on 26.13), npm, PostgreSQL 18 binaries, and PowerShell 7. Run these commands from this directory:

```powershell
./scripts/postgres-setup.ps1
npm ci
npm run migrate
npm run seed
npm run import
npm run dev
```

The setup defaults to `C:/Program Files/PostgreSQL/18/bin` for the PostgreSQL binaries. To specify another path, run `./scripts/postgres-setup.ps1 -PostgresBin 'D:/PostgreSQL/18/bin'`. The separate `.local/postgres` cluster listens on `127.0.0.1:55432` alongside existing services. Repeating setup or seed preserves existing data. Host mode accepts only this loopback port and the named demo databases. With `BACKOFFICE_RUNTIME=docker`, the database connection must use `db:55432` inside Compose. The API listens on `0.0.0.0:3001` behind a loopback port mapping. Run only one of the native or Docker APIs on port 3001 at a time.

Check the [API health endpoint](http://127.0.0.1:3001/api/health). Start the frontend from the adjacent `backoffice-frontend` directory at `http://127.0.0.1:3000`. Use `127.0.0.1` as the host for both projects.

Open **`.local/demo-accounts.json`** for the admin and Francesca operator accounts and their randomly generated passwords. PostgreSQL credentials are in `.local/postgres-credentials.json`, and setup generates `.env`. Git excludes these files and private attachments.

Build with `npm run build` and start the build with `npm start`. Import manually with `npm run import` or the Import button in the UI. Run `npm run import:watch` in a separate terminal to rescan every 60 seconds. The UI reads through HTTP from the application database, which imports data from PostgreSQL.

## Verification and demo scenario

```powershell
./scripts/postgres-verify.ps1
npm run migrate -- --test
npm run seed -- --test
npm run typecheck
npm run lint
npm test
npm run build
npm run openapi
npm run demo
```

The tests use a real `delivery_backoffice_test` database. Importer tests also create unique application and source schemas. The source fixtures remain intact. HTTP tests use the actual authentication, role, and Origin guards. Cleanup touches only resources owned by each test.

`npm run demo` covers sign-in, import, two visits, several crews, a document, a crew-reported issue and private DEMO photo, partial quantities, a return request, completion of the outstanding work, DEMO signatures, explicit closure, and a repeat import. The UI displays the result. Replaying the completed scenario is idempotent. The demo runs locally through the command line.

OpenAPI is generated at `docs/openapi.json` and available after sign-in through `GET /api/openapi.json`. The frontend uses the HTTP contract independently of backend runtime code and entities.

## Customer confirmation of the visit time

After crew assignment, the visit waits for customer confirmation. An admin or operator, including Francesca, records it in the visit card through `POST /api/deliveries/:id/appointments/:appointmentId/confirm-customer` using the current delivery version. The server records the actor, timestamp, and history event. Shared domain rules require confirmation before starting the visit or recording a result. Rescheduling requires a new confirmation. Changing staffing or transport in the same time window preserves confirmation. Cancellation releases resources and keeps the confirmation in history. The visit JSONB record stores the confirmation without a dedicated migration.

Verification covered 113 backend tests on isolated PostgreSQL, typecheck, typed lint, a Docker build, and a demo of recording confirmation and cancelling the visit in Chrome.

## Crew frontend sign-in and visit access

The [separate mobile PWA](../crew-frontend/README.md) listens on `127.0.0.1:3002`. Its proxy allows only the permitted `/api/crew` methods. The backend checks the exact `CREW_FRONTEND_ORIGIN`, which defaults to `http://127.0.0.1:3002`. Crew and operator sessions are separate. `crew_session` stores the token hash. Changing the login, password, or Enabled state revokes sessions. The list is limited to 200 visits, with active visits first and cancelled visits excluded. The visit card checks the current assignment by UUID and returns tasks for the crews the person works with on that visit. Responses are private and uncached.

The `CrewSession1793700500000` migration was applied to the local Docker database after a PostgreSQL backup in `.local/backups/20261105T131948Z_crew-phase1/`. Main and test verification use separate databases. Verification passed **119 backend tests**, including HTTP tests with real guards and PostgreSQL, typecheck, typed lint, build, and OpenAPI generation. The importer processed 20 fake pickings after restart.

In phase two, `POST /api/crew/visits/:id/start` starts a confirmed visit. `PATCH /api/crew/visits/:id/checklist/:checklistId` records progress on the participant's assignment, and `POST /api/crew/visits/:id/issues` associates an issue with one private PNG or JPEG of up to 5 MiB. The last two commands require `in_progress` status. Commands use the delivery version and `requestId`, verify the session and assignment under a lock, and record the actor in the audit log. The issue, photo metadata, and command receipt commit together. An error removes the unregistered file. If the process stops before commit, the file can remain in a private directory without an accessible link. Phase two uses the existing schema. Verification covered **120 backend tests** on isolated PostgreSQL, typecheck, typed lint, the Docker build, and OpenAPI.

In phase three, `PATCH /api/deliveries/:id/appointments/:appointmentId/responsible` lets an operator or admin explicitly select one enabled participant from the actual staffing roster. Removing that person from a booked visit clears the selection and records the change in history. Only the assigned lead can submit `POST /api/crew/visits/:id/finish`. The result stores the work summary, actual times, quantities in thousandths of a unit, and a snapshot of all assignments and checklists. The start time comes from the start record or its audit entry. For an older visit without that record, the lead must enter the actual start time. Partial reports are supported. Delivery closure is a separate command, and signature fields stay empty until signatures are collected. This phase uses the existing schema. Verification covered **121 backend tests** on isolated PostgreSQL, including concurrent retries, and a Chrome demo with two crews.

In phase four, `POST /api/crew/visits/:id/finish` stores two handwritten signatures with the visit result. The form supplies the customer or recipient name, and the server takes the lead's name from the confirmed assignment. The API validates drawing sizes, the presence of strokes, and that the signatures differ. Backoffice → History shows both signatures alongside the result, names, and timestamps. Delivery lists and the calendar omit the drawings. Existing results remain readable on the existing schema, and delivery closure stays a separate command. Verification covered 123 backend tests on isolated PostgreSQL, typed lint, typecheck, a Docker build, and the local DEMO/OUT/0011 scenario.

In phase five, `POST /api/crew/visits/:id/finish` requires 1 to 100 JPEG or PNG files, up to 5 MiB per image and 20 MiB total. The completion photos, private file references, and visit result commit together. Replaying the same request stores a single result. Photos in Issues & returns retain their issue links. Backoffice shows thumbnails in History → Completion photos. The new rule applies when submitting the result. Previously submitted results remain readable on the existing schema. Verification covered 123 backend tests on isolated PostgreSQL and a two-photo demo for DEMO/OUT/0013.

When the customer is absent and no work took place, the assigned lead can select **Customer absent** on a started visit. `POST /api/crew/visits/:id/attempt-failure` accepts `version`, `requestId`, and a required `reason` of up to 2,000 characters. The command records `failed` status, the reason, participant, and timestamp in one transaction. This outcome requires no signatures or completion photos. History displays the reason, previously delivered quantities are preserved, and remaining work is available for a new visit. If there is no other work or active visit, the delivery returns to **Inbox to plan**. Any linked follow-up request becomes bookable again. The vehicle and driver stay reserved through the scheduled return.

This scenario requires the `FailedAttempt1793700600000` migration. Compose runs it through its `migrate` service. In native mode, run `npm run migrate`. Run the end-to-end regression with `npx --no-install tsx --test test/crew-access.test.ts` against separate PostgreSQL test data. It covers access denial, replay, rollback, History, the full remaining quantity, and closure after a successful follow-up visit.

### Route drafts

[Route timing](docs/route-time.md) covers departure, sequential ETAs, work, and return without Google API, along with demo starting points in Catania and Messina and acceptance checks at new public addresses.

The `RouteDraft1793700700000` migration adds versioned drafts. Admins and operators use `/api/routes`, `/api/routes/jobs`, and `/api/routes/preview`. Nearby search uses straight-line distance between known coordinates. ETA uses directional demo or manual travel times and work duration. If a travel time is missing, subsequent ETAs and the return time remain unknown. The customer window applies if the address has exactly one confirmed visit on the departure date in Rome.

The [MVP scenario](docs/mvp-pilot.md#multi-stop-route-draft) documents verification with two synthetic pickings, the seed command, and expected ETAs. For calculation tests, run `npx --no-install tsx --test test/route-calculation.test.ts`. Add `test/crew-access.test.ts` for HTTP tests with real authentication and PostgreSQL.

#### Google Maps on the local stack

In a Google Cloud project with billing enabled, enable Maps JavaScript API and Routes API. Create a separate browser key restricted to Maps JavaScript API and the `http://127.0.0.1:3000/*` referrer. Restrict the server key to Routes API and the outbound IP address if it is static. Set quotas for the demo project. [Google Maps key restrictions](https://developers.google.com/maps/api-security-best-practices).

Save the settings in the ignored `.local/google-maps.json` file inside the backend directory. For native mode, restart the API after saving the file.

```json
{
  "browserKey": "BROWSER_KEY",
  "routesKey": "SERVER_KEY"
}
```

The local map can use the default demo Map ID. If you have a custom JavaScript Map ID, add the `mapId` field. For initial Docker setup, pass the JSON through stdin to the existing private volume and restart the backend. The setup command protects an existing file from overwrite.

```powershell
Get-Content -Raw -LiteralPath '.local/google-maps.json' |
  docker compose exec -T backend node -e "const fs = require('node:fs'); fs.writeFileSync('/app/.local/google-maps.json', fs.readFileSync(0), { mode: 0o600, flag: 'wx' });"
docker compose restart backend
```

After **Refresh drafts**, the browser receives only the restricted browser key. The server sends Google the selected coordinates in draft order. Travel time estimates exclude live traffic. Limits are 25 stops, 30 requests per minute, and two concurrent calculations per process. Results are used in the open draft only. Use demo addresses for verification. Before using customer addresses, agree on coordinate sharing and the applicable terms. [Routes API policies](https://developers.google.com/maps/documentation/routes/policies).

#### Address review and unloading entrance

The `DestinationEntrance1793700800000` migration adds separately confirmed entrance points. Backoffice uses the confirmed entrance in Routes for the next delivery from the same source to the same customer and address. An address change invalidates the previous point for routing. Confirmation history records the actor, timestamp, and version. Odoo retains its original address.

**Review unloading entrance** immediately displays the available demo reference point. For external lookup, enable Geocoding API and add a separate restricted server-side `geocodingKey` to the same local settings file. After the API restarts, external lookup is limited to two public demo addresses listed in `src/routing/google-geocoder.ts`. Both are municipal buildings in Milan and Monza. Google results serve as a temporary reference. The operator independently verifies the entrance before saving. Operators without keys can enter coordinates confirmed by the customer or crew. [Geocoding API documentation](https://developers.google.com/maps/documentation/geocoding/geocoding) · [Google Maps terms for the EEA](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms).

All 124 backend tests passed on isolated PostgreSQL 18.6. The `DEMO/OUT/0002` browser scenario verified that Crew required a reason, removed the visit from Upcoming, displayed the reason in History after a refresh, and retained a balance of one table and two chairs. The HTTP follow-up with photos and signatures allowed closure.

## Vehicles and multiple sales orders per picking

The dynamic **Vehicles** catalogue is below Skills. A company or external carrier vehicle is assigned to a particular visit with a separate time interval and optional driver. The server checks vehicle and participant conflicts. Replacements and cancellations retain history. With the API running, `./scripts/demo-vehicles.ps1` adds only missing fictional vehicles. [Transport rules and API](docs/vehicles.md).

Each delivery represents one picking, which may contain several sales orders. Lines retain their order IDs. Quantities, issues, and follow-up visits are tracked by the original picking line ID. [Demo source model and expected results](docs/source-model.md).

## Permissions

| Action | Operator | Admin |
| --- | --- | --- |
| Read all deliveries, calendar entries, history, and files in the demo workspace | Yes | Yes |
| Import, manage instructions and visits, assign, waive tasks with a reason, handle issues and returns, close or reopen | Yes | Yes |
| Manage crews, participants, skills, vehicles, and templates | No | Yes |
| Create commercial orders or write to Odoo | No | No |

Passwords use scrypt. The server stores random session token hashes, uses HttpOnly and SameSite=Strict cookies, and controls expiry and logout. Mutations require JSON and an exact Origin. `Secure=false` is allowed only for the local HTTP demo. Both roles see all records in the single demo workspace. External participants are scheduling resources that do not automatically get accounts.

## Prototype model and limitations

One delivery represents one picking. A sales order may have multiple pickings with different lines. Products come from `stock_move` for the specific picking. See the [source model](docs/source-model.md) for field provenance, SQL, and expected IDs.

A delivery is stored as a versioned JSONB aggregate with a strict runtime schema for source data, items, local instructions, visits, task, staffing, and result snapshots, issues, and returns. This simplifies the small prototype. Users, sessions, crews, templates, appointment identifiers and intervals, reservations, files, import logs, audit entries, and command receipts are normalized separately. Foreign-key, unique, and check constraints protect relationships across tables. Domain commands validate references inside the aggregate.

The command, version, and audit entry commit in one TypeORM transaction. A stale version returns 409. Replaying a booking, assignment, or result with the same ID and payload stores it only once. An advisory lock serializes schedule checks and writes, which limits throughput on the local stack. Checks cover crews, shared or external participants, half-open `[start,end)` intervals, UTC offsets, and Europe/Rome.

Repeat imports update only source-owned fields. A picking that no longer matches the filter is retained for review and blocked from new planning. If its address or quantity changes after booking, a warning is shown. Signed snapshots are immutable. The review clears when the source matches again. Full scans have a 5,000-picking limit and fail explicitly above it.

Assignments snapshot crew members and templates. Disabling them blocks new assignments while preserving existing ones. Severity and order are independent. Checklists record tasks independently of delivery quantities. Quantities support up to three decimal places and are stored as integer milli-units.

## Status and closure

| View or action | Rule |
| --- | --- |
| Inbox | There are no active visits or completed work |
| Planned | A visit is booked without an assigned crew |
| Assigned | A crew is assigned. Coverage for all visits is shown separately |
| In progress | A visit has started. This status takes priority |
| Partially completed | Work has been reported and products, tasks, or visits are outstanding |
| Awaiting closure | Work is complete. Explicit closure is required, and any blockers are shown |
| Issues / Return required | The filters can overlap, so a delivery may count in both |
| Completed | An explicit domain command closes the delivery once all conditions are met |
| Reopen | A reason is required and the previous completion stays in history |

Closure requires the full product quantities, completed tasks or reasoned waivers, finished visits, resolution of all issues and returns, both signatures for each completed visit, and a verified source. Booking a follow-up sets the request to `planned`. The demo requires all remaining deliveries and the linked visit's tasks to be complete before resolving a return request. The fixture uses explicitly labelled DEMO signatures.

Private files are stored in `.local/files`. Downloads require a session and the delivery ID. The backend validates the file type, size, and name independently of the client MIME type. Accepted formats are PDF, TXT, PNG, and JPEG up to 5 MiB. Responses use `attachment` and `nosniff`. Upload states are pending, ready, and failed. Missing files return an error. The demo validation checks file formats and leaves malware scanning to an external control.

See the [backup and recovery verification](docs/recovery.md) for restoring into **new** demo databases. The source, application database, and filesystem are separate transaction boundaries.

See [implementation status](docs/STATUS.md) for results, versions, and remaining limitations.

The [geography demo](docs/geography-demo.md) documents Inbox filters and repeatable demo province and postal code data without Google API. Synthetic metadata is stored separately from the original Odoo snapshot. Source fields will be reconciled when connected.

All `Via Dimostrativa` addresses in the current demo were replaced with [public Catania and Messina addresses with building coordinates and verified sources](docs/public-demo-addresses.md). Recipients are fictional. Building points require separate confirmation as unloading entrances. The runbook provides repeatable updates through fake Odoo and the normal importer. The source connection remains read-only.

See [participant profiles and flexible staffing](docs/people-and-staffing.md). PostgreSQL stores `person`, `crew`, and `crew_member` separately and retains the original crew JSON in `legacy_data`. A participant can belong to at most one default roster, including disabled crews. The default roster is a template. Staff available for a visit can be selected without changing that template or history. Profiles include first, last, and preferred names, phone, address, and optional front-office credentials. The password is write-only and stored as a hash. These credentials are scoped to the front office.

For an existing local database, stop the API and importer before migration, then take a consistent backup with `./scripts/postgres-backup.ps1 -WritersStopped`. Run `npm run migrate`, separately run `npm run migrate -- --test` for the test database, build with `npm run build`, and start with `npm start`. Existing data needs no reseeding. Verification compared the original records and used isolated PostgreSQL tests. The migration has no automated destructive rollback.

New HTTP commands are `GET/POST /api/participants`, `PATCH /api/participants/:id`, and `GET/PATCH /api/deliveries/:id/appointments/:appointmentId/participants`. Full request and response schemas are in the generated OpenAPI. Default roster changes accept `participantIds`. Changes to the staffing of a visit send all assignment IDs, the delivery version, and a reason in one request. Profile writes require admin authorization. Scheduling requires a valid Backoffice session.

To populate 20 known demo profiles with fictional Italian names and contacts, run `npm run demo:italian-participants` while the local API is running. The command uses a real admin session, matches profiles only by UUID, replaces known DEMO placeholders, and fills empty fields. Existing values, flags, and passwords are preserved. This replacement is separate from the non-destructive normal seed. New logins use `@example.test`, phones carry the demo prefix `+39 000`, and addresses are labelled `indirizzo fittizio`.

Randomly generated passwords are saved **before** the HTTP PATCH to the ignored `.local/participant-demo-accounts.json` file and kept out of console output. PostgreSQL stores only their hashes. A repeat run on populated profiles skips PATCH calls and preserves profile versions and the credentials file. The command stops on a version conflict or uncertain response. A retry reads current profiles and uses the saved credentials. Crews, memberships, visits, reservations, and signed history are preserved. The prepared fields alone are insufficient for front-office login.

## Participant calendar

`GET /api/participants/:id/calendar?from=<ISO>&to=<ISO>` is available to valid admin and operator Backoffice sessions. The interval requires an explicit UTC offset, an end after the start, and a range of no more than 45 days. Visit overlap uses `[start,end)`. Responses contain a public profile with no login or `hasPassword` and actual assignments for the participant UUID, including the date, visit start and end, status, picking and customer, saved crew, task, and checklist snapshots, and the follow-up flag. A default crew roster alone creates no calendar entries. The calendar distinguishes people with the same name by UUID. Completed and cancelled visits remain visible in history. Tasks use the shared visit interval. The projection excludes results, signatures, and files.

Participants opens a separate read-only Backoffice page at `/participants/[id]/calendar`. The feature uses the existing database schema. Backend verification passed **76/76 tests**, typecheck, typed lint, build, and OpenAPI generation. The new tests use the real guards and an isolated PostgreSQL schema. They cover permissions, interval boundaries, UUIDs, snapshots, exclusion of credentials, and preservation of business data.

The final frontend `npm run verify` passed **38/38 tests**, typecheck, typed lint, and build. A live read-only API smoke test using an active operator session and the new endpoint passed **1/1**. Both production-mode servers were started locally. In the browser, opening Simone from Participants showed Catania Uno from 09:00 to 11:00 and Assembly Studio from 11:00 to 13:00 on November 10, with the Check products task. The browser checks covered Refresh, opening a delivery, and returning to Participants with business data preserved. See the frontend documentation for detailed observations and the [screenshot](../backoffice-frontend/docs/screenshots/participant-calendar.jpg).

## Month view in both calendars

The main and participant calendars share Day / Week / Month views, Previous / Today / Next controls, and a month selector. Month shows four, five, or six full Monday–Sunday weeks, including adjacent months. When changing months, the day is capped at the last available day in the new month. Leap years and Europe/Rome daylight saving time are handled. A date or “+ more” opens Day view. An event opens the delivery. Refresh preserves the mounted month grid, selected view and month, filters, and scroll position.

The shared limit for `/api/calendar` and `/api/participants/:id/calendar` increased from 32 to **45 days** to fit a six-week grid with the extra hour at the autumn daylight saving transition. Strict ISO timestamps with an offset, interval bounds, half-open overlap, authorization, and the response formats were preserved. Backend verification passed **77/77 tests**, typecheck, typed lint, build, and OpenAPI generation. The regression uses real guards and PostgreSQL to test 42 days plus one hour, exactly 45 days, and rejection at one millisecond over the limit. The change uses the existing schemas and dependencies.

The final Month frontend `npm run verify` passed **47/47 tests**, typecheck, typed lint, and build. A live read-only API smoke test using an active operator session checked full 42-day requests to both endpoints and passed **1/1**. The local API and UI were restarted. In the browser, both month grids were checked, including Previous / Next / Today, navigating from a date to Day, opening `DEMO/OUT/0002`, Refresh, and contained overflow at 320 px. Business data was preserved. Screenshots include the [main Month view](../backoffice-frontend/docs/screenshots/calendar-month.jpg) and [participant Month view](../backoffice-frontend/docs/screenshots/participant-calendar-month.jpg). Detailed measurements are in the frontend design system.

## One default crew per participant

The updated rule gives each person UUID **0 or 1** default membership across all crews, including disabled crews. Admin crew POST and PATCH operations check this within the shared advisory transaction. Conflicts return 409 with the names of the participant and current crew. `UNIQUE(person_id)` on `crew_member` also protects against concurrent saves. Visit staffing stays independent: an available participant can work with another crew in a different interval, and existing assignment, task, and result snapshots are immutable.

After the backup at `.local/backups/20261103T164641Z_b1425d82`, the user chose to keep Antonio Lombardo in Messina Due, Alessandro Costa in Catania Uno, and Andrea Grasso in Catania Due. One real admin HTTP PATCH raised Assembly Studio (`10000000-0000-4000-8000-000000000005`) from version 10 to 11 and removed only those three UUIDs. Its default roster is now empty and the other crews were preserved. The baseline is `.local/single-crew-before-20261103T164641Z.json` and the evidence is `.local/single-crew-repair-20261103T164641Z.json`. Then `UniqueDefaultCrew1793700200000` was applied to the main and test databases. The migration stops with a report before DDL if it finds duplicates. Membership decisions are made before migration.

Backend verification passed **80/80 tests**, typecheck, typed lint, build, and OpenAPI generation. Frontend verification passed **51/51 tests**, typecheck, typed lint, build, and the live read-only API smoke test (**1/1**). See [participant profiles and flexible staffing](docs/people-and-staffing.md) for the migration commands and the distinction between a default roster and actual visit staffing.

## Participant skills

[Skills](docs/participant-skills.md) is a dynamic catalogue under Delivery views. Skills belong to participants by UUID and remain attached when they work with a different crew. They are demo records, not proof of qualification. Admins can create, edit, and assign skills. Operators can read them. Task templates define requirements, and **each** selected participant in **every** crew needs **all** required skills for the selected tasks. When updating visit staffing, the system uses the saved task requirements. A disabled required skill blocks new assignments or staffing changes. Signed snapshots are immutable.

All **95/95 backend tests**, typecheck, full typed lint, and runtime and tools builds passed in Docker. Frontend typecheck, typed lint, **62/62 tests**, build, and live read-only HTTP smoke test (**1/1**) passed. Backend test files run serially because they share PostgreSQL advisory locks. Concurrency is still exercised within individual tests. `ParticipantSkills1793700300000` was applied to the main and test Docker databases after a fresh consistent backup. Independent checks covered existing records, history, application data, and seven secret files. Both databases have four migrations. The API, importer, and database run in Docker, and the frontend runs on the host. The native cluster is saved and stopped.

Use the following commands to populate the demo catalogue and the specific example through a real admin HTTP session:

```powershell
./scripts/demo-skills.ps1
# Optional: assign six skills to the demo participant Simone and require Furniture assembly for the known Assemble template.
./scripts/demo-skills.ps1 -AssignSimoneExample
```

The first run created six skills and made two metadata updates. Repeating it made no changes. The browser demo added Heavy lifting and saved Heavy lifting and Product inspection for Antonio. These are fictional training examples. The commands preserve previous visits, rosters, contact details, passwords, and signed history. See [participant skills](docs/participant-skills.md) for the exact UUIDs, API rules, backup, and verification scope.

## Odoo development-copy integration

The optional read-only Odoo 18 adapter runs in a separate local Docker stand; the teaching demo remains independent. Configuration, confirmed field mappings, unknowns and startup commands are documented in [docs/odoo-integration.md](docs/odoo-integration.md). Source credentials belong only in the private local configuration, never in this repository.

Import automatically locates eligible text addresses with Geoapify and caches them in the application database without changing Odoo. It skips placeholders and reuses saved coordinates. Backend-only key configuration, processing limits, the separate Docker mount and approximate-result review are documented in [docs/geocoding.md](docs/geocoding.md).

