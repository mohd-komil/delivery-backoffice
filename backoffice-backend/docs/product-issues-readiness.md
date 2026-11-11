# Product problems and damage readiness

Implemented 2026-11-11. Product checks, incomplete-work reasons and operational issues remain distinct. Identity is the source line and sales order; the SKU is never used to merge incidents or remaining work.

## Reporting and links

Each `itemChecks` entry with `status: "problem"` creates or links one Issue in the same transaction as its signed result. Optional `problemType` is `damage`, `missing_parts`, `access` or `other` (default `other`). Optional `linkedIssueId` must identify an open Issue on the same source line and delivery, scoped to the same visit or an older unscoped Issue. A unique existing open visit/line issue is reused automatically; multiple candidates require an explicit choice. An `ok` check cannot submit a problem type or link.

The saved result includes server-generated `issueLinks`. New Issues carry `appointmentId` and `originResultId`; an operator can supply the visit when opening an Issue. Linked completion photos retain their product line and get the same Issue ID in private file metadata. Generic visit photos are not silently attributed to a product. Existing issue photos and new photos are combined without duplicates.

The request fingerprint includes the selected link, problem category, reason and note. Identical retry returns the original persisted result and adds no issues, holds, photos or audit entries. Changed input under the same request ID conflicts. Signed corrections preserve original reports, reuse existing incident links and never silently resolve an Issue or release its hold. Reports without the new optional fields retain their old representation.

## Readiness

A typed damage Issue or an incomplete-work `damage` reason creates a `workHolds` event for each affected source line. A reason alone does **not** create an Issue. A damage Issue requires at least one product line. The hold blocks all remaining operations for the damaged line, leaving other orders with the same SKU independent.

`PATCH /api/deliveries/{id}/work-readiness/{sourceLineId}` accepts `{ "version": 12, "note": "Replacement inspected and ready at the warehouse." }`. An authenticated operator/admin releases all currently open holds on that line. Each release preserves its explanation, author and timestamp; the `work.readiness_confirmed` audit event identifies the line. Resolving an Issue alone does not release readiness. A later damage incident creates another hold.

New booking, editing a work scope and starting affected booked work reject held lines. Existing appointments are retained and report `damage_hold` for review. A crew already working must still be able to report the damage and finish its current visit; the hold affects future planning/start, not submission of that incident. Other source, scope, stock, responsibility and signature checks continue to apply.

## Migration and local demo

`WorkReadiness1793701000000` adds holds to unfinished deliveries for effective historical damage reasons and open typed damage Issues. It preserves the JSON of all signed appointment/result snapshots, increments only changed aggregate versions and records `work.readiness_backfilled` with the added hold IDs. Superseded damage reasons and closed deliveries are excluded. Existing explicit releases are preserved. Reapplying the migration adds nothing. Down migration intentionally refuses to discard readiness/release history; recovery requires a reviewed backup procedure.

Isolated PostgreSQL coverage: `test/work-readiness-migration.test.ts`. Domain coverage: `test/work-scope.test.ts`. Authenticated reporting, ownership, CSRF, private photos, retries and readiness are covered by `test/crew-access.test.ts`; signed corrections also run through `test/execution.test.ts`.

Add a separate source-only demo without changing previous examples:

```powershell
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/scripts:/app/scripts:ro" tools npx tsx scripts/demo-operations-followup.ts --apply
npx tsx scripts/demo-operations-followup-api.ts --prepare
```

`--prepare` authenticates through real admin/Crew login, uses the existing Matteo Ferraro account, attaches versioned line instructions, books/assigns/starts one dedicated visit, completes its checklist and raises one photographed damage Issue. It leaves the visit in progress for browser reporting. `--exercise` on a fresh demo also submits synthetic photos/signatures, verifies identical retry, verifies that damage remains blocked and uploads a later instruction version without changing the report snapshot. `--inspect` is read only. An existing prepared demo is never reset or recreated. Credentials remain in existing ignored local account files; script output contains no passwords or sessions.

Demo delivery: `DEMO/FOLLOWUP/0001`, UUID `a5d69c9e-38ed-4d2e-a411-755b50aa2001`. Orders `9401` and `9402` share `FOLLOWUP-CHAIR`; source lines `940011` and `940021` stay independent. State and explicitly synthetic image fixtures are under `.local/operations-followup-demo-state.json` and `.local/DEMO-followup-line-*.png`.

## Verification checkpoint

On 2026-11-11, backend typecheck, typed lint, production build and OpenAPI generation passed. The isolated PostgreSQL suite passed **229/229** with no skips after the dedicated `delivery_backoffice_test` database received its pending migrations. Log: `.local/operations-followup-backend-tests-20261111.log`. The subsequent Crew read-model correction also passed the focused HTTP suite **14/14**: a damage hold discovered during active work leaves Finish available while future start remains blocked.

The source-only fixture was inserted once and repeated with zero inserts. Authenticated setup prepared visit `3d8c1d2f-c7a1-44bc-bc22-2c4ef7c8b2b6` for Matteo Ferraro (`20000000-0000-4000-8000-000000000010`), Catania Due. The subsequent Chrome walkthrough submitted the report through Crew with both drawn DEMO signatures and two explicitly synthetic line photos. Order 9401 reported delivery 1 / installation 0, damage and missing-parts reasons, and linked its existing damage Issue. Order 9402 reported delivery 1 / installation 1, time-shortage reasons and an OK check. Backoffice History displayed the line-specific results, photos, reasons, linked Issue and instruction version 2.

The browser then uploaded instruction version 3 and explicitly released line 940011 with the explanation: “DEMO: replacement chair inspected in the teaching scenario; parts and access confirmed. Release only order 9401, line 940011.” The authenticated author is **Demo Administrator**, at `2026-11-11T13:05:43.337Z`. Read-only API verification confirmed:

- Exactly one signed result (`fe946a43-b9ae-487c-b092-92ff28784f34`) and one still-open Issue (`5b7f2ba9-a905-4a02-bbf6-19e4034c646f`). Readiness release did not resolve the Issue.
- One damage hold, now explicitly released; both source lines have no planning block. Remaining/available work is delivery 1 + installation 2 for line 940011, and delivery 1 + installation 1 for line 940021.
- Instruction versions 1, 2 and 3 are retained. The signed report still references version 2 (`17b40d1a-4d94-4ba5-90b2-f97e0c5677a3`); version 3 is `198ff698-3adc-4b0c-9bf2-f10947ea2a0c`.
- The report SHA-256 remained `d5db5daf8c5890f5ebed582e079925a2f884832955feb21243fc8220cb8912d9` before and after document replacement and release. Both signatures and both line-photo references remain present.

Evidence: `.local/operations-followup-report-verification.json`. `npx tsx scripts/demo-operations-followup-api.ts --verify-report` performs the report checks through authenticated read-only HTTP and writes local verification output. The browser scenario did not alter prior Gianluca/Reasons fixtures, create commercial orders or write to Odoo.
