# Stage 06: route publication review

Routes now has a separate **Prepare publication** panel beneath the saved draft. Saving a draft still does not book visits or resources.

- Each new stop selects exact work quantities by source line, task templates, a responsible actual participant and an optional existing return request. The same SKU in two orders remains two lines.
- A stop linked to a booked visit shows its existing scope, responsibility and customer confirmation. The publication form cannot silently replace them; **Open delivery details** opens the existing correction workflow.
- **Review publication** obtains the server's fresh schedule, work snapshots, resource checks and fingerprint. The complete departure–return interval and transfer buffer are visible. The dispatcher must explicitly acknowledge approximate travel times before publishing.
- `GET /routes/publication-capability` controls availability. On the shared stand the gate stays off until departure, cancellation and actual-return workflows are available. Reviewing is allowed while publication is disabled.
- Publish retries reuse a request ID for the same reviewed command. A conflict invalidates the review and acknowledgement. Successful publication removes the editable draft and displays the saved immutable review. Confirmation badges in this saved review are explicitly labelled **at publication**, not live customer status.
- Refresh reloads data without unmounting edited quantities, tasks or responsible selection. A changed data revision invalidates an old review. Hiding and reopening the panel also retains selections.
- Participant calendars show whole-trip reservations in a separate section, so time between on-site visits is not presented as free time.

All new interface text is available in English, Italian, Russian and Uzbek. The browser remains an authenticated HTTP client; no browser database access, bypass credentials or Google API was introduced.

## Verification

Commands in this project:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

`test/route-publication.test.ts` covers the disabled gate, exact work, preserved edits on Refresh, acknowledgement, idempotent retry, attach-only commands, stale conflicts and immutable readback. The participant-calendar regression distinguishes whole-trip reservations from visit entries.

The real browser acceptance uses a separate frontend on port 3010 and a real backend on port 3011 with a dedicated PostgreSQL test schema. The main `delivery_backoffice` database and backend containers were not migrated, reseeded or replaced. The frontend worktree and local build do contain this stage's changes. The test API's generated credentials stay in the backend's ignored `.local/publication-browser-demo/connection.json`; they are not part of this document.

### Isolated frontend launch

The acceptance frontend is a disposable source copy at `C:/Users/MOHD/AppData/Local/Temp/backoffice-publication-browser-20261111`. It has its own Next output directory and reuses the installed dependency directory through a local junction, so it does not contend with the normal frontend build. No dependency install is required. To reproduce the copy, run from `backoffice-frontend`:

```powershell
$demoFrontendRoot = Join-Path $env:TEMP 'backoffice-publication-browser-20261111'
$frontendSourceRoot = (Get-Location).Path
New-Item -ItemType Directory -Path $demoFrontendRoot -Force | Out-Null
foreach ($item in @('src', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs', 'next-env.d.ts')) {
  Copy-Item -LiteralPath (Join-Path $frontendSourceRoot $item) -Destination $demoFrontendRoot -Recurse -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $demoFrontendRoot 'node_modules'))) {
  New-Item -ItemType Junction -Path (Join-Path $demoFrontendRoot 'node_modules') -Target (Join-Path $frontendSourceRoot 'node_modules') | Out-Null
}
Set-Location $demoFrontendRoot
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3011/api'
node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3010
```

Open `http://127.0.0.1:3010/` only after the dedicated test API is ready. Its newest connection manifest is authoritative: restarting that harness creates a new isolated schema, account and route IDs. Publication is enabled only in that test API. The shared stand remains gated.

### Observed acceptance — 11 November 2026

Chrome used the real API and PostgreSQL schema `route_publication_demo_4534ded9e60341caa058687204c6003d`.

1. Published **DEMO · Publish two new visits** (`e7b5fc5a-12fa-42d0-be67-ba89ffc72961`). The two Pickings each retained two independent same-SKU order lines, with exactly one unit selected on each line. Refresh preserved all four quantities, task checkboxes and responsible selections. A repeated Refresh at the top retained scroll position `0 → 0`; it invalidated the previous acknowledgement and disabled Publish until a fresh review.
2. Published **DEMO · Attach confirmed visit and create next stop** (`d0301c44-912b-4638-8214-4b426ff1eb22`). The attached stop retained quantities `1` and `0.5` and its existing customer confirmation; the new stop used `1` and `0.5` and remained awaiting confirmation. Refresh and a full page reload/reselection displayed the immutable published version without an editable draft. The saved order IDs remain visible even when the current delivery source is not loaded.
3. Marco Rossi DEMO's calendar showed the full reservation **13 November, 09:00–10:08 Europe/Rome**, with a **10-minute transfer buffer**, separately from visits **09:00–09:30** and **09:34–10:04**. Calendar Refresh retained those records. The description now distinguishes whole-trip reservations from on-site work.
4. The accompanying read-only PostgreSQL check found two published routes, four stop memberships and four appointments, with three resource identities per route and no duplicates. The attached appointment `6672050a-a13b-493f-81e0-0cdd882f6f36` retained its previous scope, assignments and confirmation; publication added its transport allocation.

Checked desktop dark/system and light themes plus a 390px viewport. Mobile document width was 381px inside the 390px viewport, without horizontal page overflow. The temporary viewport and theme were restored. Current-page console warnings/errors were empty after the final reload. Screenshots: published create (`screenshots/route-publication-create.png`), attached and new stops (`screenshots/route-publication-attach.png`), mobile summary (`screenshots/route-publication-mobile.png`), participant calendar (`screenshots/route-publication-calendar.png`).

The complete frontend suite passed **196/196** before adding two targeted scenarios. The final publication and participant-calendar run passed **14/14**, including those scenarios and the final wording/order-label changes. This is not a claim that the enlarged full suite was rerun. Final `npm run typecheck`, `npm run lint` and `npm run build` all exited successfully after those changes. Node emitted its existing `module.register()` deprecation notice; no check was disabled. A missing publication endpoint on an older backend affects only the publication panel; normal route editing and standalone workflows remain available.

Screenshot paths refer to local verification artifacts intentionally excluded from Git.
