# Delivery Crew

The mobile Next.js PWA gives crew members access to their assigned routes, visits, and on-site reports. It connects to the shared NestJS API over HTTP.

## Route screen — November 17, 2026

Crew highlights the next stop and lists the other stops in route order with their ETA and status. Expand a stop to see its work, visit window, and directions. The bottom action follows the route status and lets crew members record departure, start the return journey, or confirm actual return.

Typecheck, typed lint, all 56 tests, and the build passed. Chrome at 390 px verified departure, the restriction on starting the return journey while stops are outstanding, and actual return with confirmation. Use the [isolated Catania route](../backoffice-backend/docs/stage10-acceptance.md#four-stop-catania-demo) to reproduce the check. The working applications use ports 3030, 3031, and 3032.

## Visit details and report steps — November 17, 2026

The visit card shows the address, time, confirmation status, and contact options at the top. The primary action stays fixed at the bottom and becomes a navigation and submission bar while the report is open. Quantities, reasons for unfinished work, photos, and signatures stay in one form as the user moves between steps. Changes to signed data require fresh signatures.

The Crew checks passed with `npm run typecheck`, `npm run lint`, `npm test` (55 tests), and `npm run build`. The working frontend on port 3032 uses the API on 3031. The isolated synthetic demo uses ports 3012 and 3011. To reproduce the check, use the [four-address Catania demo](../backoffice-backend/docs/stage10-acceptance.md#four-stop-catania-demo). After departing and completing the first stop, open `DEMO/ROUTE4/0102`, record one of two units and the reason for the remaining unit, then verify the photo and signatures in History.

## Shared customer-development database — November 16, 2026

Use Backoffice on port **3030**, the API on **3031**, and Crew on **3032**. Set the server-side variable in `crew-frontend/.env.local`:

```dotenv
CREW_API_ORIGIN=http://127.0.0.1:3031
```

Build and start Crew from its project directory:

```powershell
npm run build
node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3032
```

Open [Crew customer-development](http://127.0.0.1:3032). For development, use `dev` with the same `--hostname` and `--port` flags. The API on port 3031 must be running and allow `CREW_FRONTEND_ORIGIN=http://127.0.0.1:3032`. The standard `npm start` and `npm run dev` scripts use port 3002 with the API on 3001. The Crew origin must match the origin allowed by the selected API.

Sign in with the credentials of a participant from **Participants on this environment**. Sessions, records, assignments, and credentials belong to the selected database.

The proxy allows `http://127.0.0.1:3001`, `http://localhost:3001`, `http://127.0.0.1:3031`, and `http://localhost:3031`. Use `BACKOFFICE_TEST=1` for the isolated `http://127.0.0.1:3011` endpoint. The default API is `http://127.0.0.1:3001`. The proxy restricts targets and paths to its allowlist and rejects redirects. The browser calls its own `/api/crew` endpoint. The proxy forwards the Crew cookie and original Origin, and the API checks authentication and assignments.

Typecheck, typed lint, **47/47 tests**, and the build passed. Proxy tests with a stub upstream cover both permitted origins on port 3031 in standard mode, Cookie and Origin handling, rejected targets, and the default port 3001. A separate live check covers sign-in and access to an assigned visit.

Chrome verified the shared environment on **November 16, 2026**. **DEMO Person 1** from **Messina Uno** signed in through the Crew form and saw **MTO/OUT/00697**, UUID `623aef3b-4ed7-449c-b299-ab6e6d7e52e5`. Backoffice and Crew showed the same November 13–14 dates, the Messina Fiat Ducato, and a planned collection of one unit for order SO082429, line 713092. The existing date places the visit in **Past visits**. The status is `booked` and awaiting customer confirmation, so Start visit is disabled.

The authorized operator API set up a local test login for the assigned participant. The participant version advanced from 1 to 2. The existing delivery record stayed at version 27 with identical JSON. The ignored `../backoffice-backend/.local/odoo-integration/delivery-odoo-customerdev/crew-demo-account.json` contains the local test login and visit reference. The command, API address, and PID are recorded in `.local/odoo-integration/crew-runtime.json`.

Live requests through the Crew proxy at `http://127.0.0.1:3032/api/crew` confirmed sign-in and access to the single assigned visit and its detail. The anonymous list request returned 401. The API on port 3031 and PostgreSQL were healthy. Odoo access is read-only. Screenshots are stored locally at `../.local/ui-verification/shared-backend-office-20261116.jpg` and `../.local/ui-verification/shared-backend-crew-20261116.jpg`.

## Shared shadcn/ui components — November 13, 2026

Combobox controls show search when there are more than five choices, excluding the placeholder. The actual start field uses a Calendar in a Popover with a separate time field. It preserves localization, required-field validation, Europe/Rome daylight-saving behavior, and timestamp precision. Shared components live in `src/shared/ui` within the Crew project. Popover animations respect reduced-motion preferences.

Typecheck, typed lint, **44/44 tests**, and the production build passed. Run `npm start` to open [Crew on port 3002](http://127.0.0.1:3002). The server-side `CREW_API_ORIGIN` defaults to the API on port 3001.

## Routes and return — November 11, 2026

**My routes** lists published trips. Route details include stop order, exact product-line work, vehicle, the responsible participant, historical driver assignments where available, and saved unloading entrances. Standalone visits are listed under **My visits**. The API authorizes departure, starting the return journey, and recording actual return separately. Stop reports and warehouse receipts have their own actions. Refresh preserves the typed note. [Contracts, checks, and isolated test setup](docs/route-execution.md).

Typecheck, typed lint, **41/41 tests**, and the production build passed. Chrome at 390 px verified departure, Start restrictions, beginning the return journey, and actual return. Refresh preserved the selected tab, note, and confirmation checkbox. Returned routes appear in History, and completed visits appear in Past visits. Use the backend harness with `--resume` to continue the same isolated demo. The default start creates a new synthetic schema. This check used desktop Chrome.

## Reasons for unfinished work — November 10, 2026

In **Finish visit**, every planned operation completed below the planned quantity requires a reason. **Other** requires a note. Notes are limited to 500 characters. Delivery, installation, and collection are tracked by order line, including when products share a SKU. The form shows and submits reasons only for incomplete operations. Editing signed data requires fresh signatures. Refresh preserves the open draft.

Typecheck, typed lint, **28/28 tests**, and the production build passed. The [DEMO/REASONS/0001 report](http://127.0.0.1:3002/visits/1f965258-fba2-4107-930a-eff220069320) was submitted in Chrome with four reasons, a photo, and two sample signatures. The 390 px desktop browser check covered the required reason, the **Other** note, and draft preservation on Refresh. [Scenario, remaining quantities, and History](../backoffice-backend/docs/demo-work-reasons.md).

## Visit work scope — November 10, 2026

**Work for this visit** shows planned delivery, installation, and collection quantities by order line. All product information stays visible. Lines outside the scope display **Not planned for this visit**. Actual quantities can be entered for planned lines only. The API rejects quantities above the plan and keeps identical SKUs from different orders separate.

Start visit requires customer confirmation, reviewed work scope, and sufficient goods already at the address or scheduled for delivery on the same visit. The dispatcher must review older visits without a work scope. Assembly awaiting an earlier delivery has its own status. For installation-only work, goods availability is recorded separately from delivery.

Typecheck, typed lint, **21/21 tests**, and the production build passed. Desktop Chrome at 390 px verified the [DEMO/GIANLUCA/0001 follow-up](http://127.0.0.1:3002/visits/8cb84445-1eee-46d2-be19-270f9f91135c). Order 9201 had one unit to deliver and two to install. Order 9202 used the same SKU and had already been completed. [Demo and work-scope rules](../backoffice-frontend/docs/visit-work-scope.md).

## Local setup

Crew sign-in requires an enabled participant account configured in Backoffice → Participants. The ignored `backoffice-backend/.local/participant-demo-accounts.json` holds synthetic credentials for the local demo. Administrators and operators sign in through Backoffice.

Run from the repository root:

```powershell
Set-Location backoffice-backend
docker compose up -d --build backend
Set-Location ../crew-frontend
npm ci
npm run verify
npm start
```

Open [Crew on port 3002](http://127.0.0.1:3002). `npm run dev` uses the same address. The API listens on `127.0.0.1:3001`. Copy `.env.example` to `.env.local` to select another allowed local API. Sign in from the origin configured in `CREW_FRONTEND_ORIGIN`, which defaults to `http://127.0.0.1:3002`.

The original teaching setup used Simone Lo Presti (`simone.lopresti.demo@example.test`). Use the participant credentials in the local demo file for your environment. `DEMO/OUT/0006` awaits customer confirmation, and `DEMO/OUT/0007` is ready to start. `DEMO/OUT/0008` was used to verify starting a visit, marking its checklist, and reporting a problem with a PNG. `DEMO/OUT/0009` contains a combined partial result that Simone submitted for Catania Uno and Messina Due. `DEMO/OUT/0011` contains a result with two sample signatures, available in Backoffice → Partially completed → History. This delivery is ready for manual closure. Completed visits appear in Past visits immediately, even when the original scheduled time is still in the future.

- **My visits** shows actual assignments for today and upcoming dates in Europe/Rome. Access requires an assignment on the visit.
- **Visit details** show the address, contact, instructions, products, assigned tasks, and customer confirmation. Start visit becomes available after confirmation. During work, members can update their crew checklist and report a problem with one JPEG or PNG up to 5 MiB. Backoffice shows that photo in Issues & returns and completed checklist items in History.
- **Finish visit** is available to the responsible participant selected by Francesca or an administrator from the actual assignments in Backoffice → Visits & tasks. Once the visit starts, the responsible participant opens **Record visit result** in Crew, enters the shared summary, and records actual quantities by line. Each crew can continue updating its tasks. After submission, Backoffice → History shows the result, the crews' checklist entries, the recorded time, and the author. A partial result completes the visit. Outstanding quantities, tasks, and signatures are checked separately when closing the delivery.
- **Signatures** are collected for the ordinary completion flow. The customer or recipient enters their name and signs in the first area. The assigned responsible participant signs in the second. Both areas support touch, stylus, and mouse and can be cleared independently. Changes to signed information require fresh signatures. Backoffice shows the drawings, names, and capture times next to the result in History.
- **Completion photos** are required for ordinary visit completion. Take a photo with the camera or select images from the gallery. The report supports 1–100 JPEG or PNG files, up to 5 MiB each and 20 MiB in total. Remove unwanted images before submitting. Editing the photo set requires fresh signatures. A result with two demo photos is available in Backoffice → Partially completed → DEMO/OUT/0013 → History → Completion photos.
- **Customer absent** is available to the responsible participant after Start visit when nothing was handed over or performed. Enter a reason and choose **End visit without delivery**. The visit moves to Past visits. Backoffice → History shows the reason, author, and time. The full remainder stays available for a repeat visit.
- **PWA** supports a web manifest, regular and maskable icons, and standalone launch. Use the production build (`npm run build`, `npm start`) to test installation. Supported browsers treat local loopback as a trusted context. For a physical phone, use an accessible HTTPS environment. The service worker caches the public connection-loss page only. Crew also runs in an ordinary browser.

Routes are in `src/app`, screens in `src/_pages`, and shared components and validated HTTP contracts in `src/shared`. The `src/_app/crew-api` proxy handles only allowed Crew methods and paths, forwards the Crew session, and disables caching. The API verifies the active assignment and delivery version. Retrying an identical request reuses its identifier. Refresh and version conflicts preserve the open form draft.

Since November 11, 2026, each planned line in Finish visit provides camera capture and photo selection with the order-line association already set. The 100-photo and 20 MiB limits cover the whole report. Identical SKUs on different orders keep independent photos, reasons, and problems. In **Problem**, select a category and optionally link an existing issue on the same line. Changes to a photo, category, or issue link require fresh signatures.

Instructions and drawings on a line item show the recorded version, date, source, and author. General delivery documents appear separately. Earlier file versions retain their original bytes. Backoffice History shows the versions available when the crew submitted the report. Missing types, versions, and sources on older documents display as unknown. Documents require an active visit assignment and use uncached requests. Typecheck, typed lint, all 33 tests, and the build passed for this update. The new previews and uploads still need a separate browser and physical-device check.

The stage-three verification passed typecheck, typed lint, 13 tests, and the build through `npm run verify`. Chrome verified two crews on one visit and read the result in Backoffice. The second participant saved a checklist entry through the local API and received 403 when attempting to submit the shared result. Refresh preserved the responsible participant's draft. Chrome verified the signature form, the missing-photo warning, and two saved thumbnails in History. The local HTTP API verified persistence of the sample signatures and photos. Touch input, camera capture, and PWA installation still require an HTTPS environment accessible to physical Android and iPhone devices.

The assigned responsible participant can finish a visit when damage is reported during that visit. The work hold blocks the start of later bookings, and other planning review reasons still apply. NestJS HTTP tests on isolated PostgreSQL and Crew contract and localization checks cover this behavior.
