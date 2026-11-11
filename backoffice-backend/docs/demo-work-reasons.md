# Per-line incomplete work demonstration

Prepared 2026-11-10. The fixture creates only a new unfinished local delivery. It does not create appointments, reports, signatures or photo evidence, and does not change other demonstrations.

## Initial data

- Picking: `DEMO/REASONS/0001`.
- Delivery ID: `a5d69c9e-38ed-4d2e-a411-755b50aa1001`.
- Synthetic source: `work_reasons_demo`, source ID `930001`.
- Fictional customer: DEMO Elena Marino. Address and building coordinates reuse public reference 3 in `local/public-demo-addresses.json`; this is not a real customer's address or a verified unloading entrance.
- Sales order `DEMO/WR/SO/9301`, source line `930011`: 2 units of `WR-CHAIR`, delivery + installation.
- Sales order `DEMO/WR/SO/9302`, source line `930021`: 2 units of the same product, delivery + installation.
- Initially each line has 2 deliveries and 2 installations remaining.

## Add the fixture

From `backoffice-backend`, using the existing validated local environment:

```powershell
npx tsx scripts/demo-work-reasons.ts --apply
```

For the isolated test database, use `--test`. The command requires the existing local database configuration, checks the actual database name and PostgreSQL port, and rejects production. The Docker tools image must include the new script before it can be run there; run the same command through the existing tools service if the environment is Docker-only.

Rerunning preserves every existing appointment, assignment and report. A conflicting fixture identity aborts instead of overwriting data. No Odoo records or credentials are created.

## Demonstration through normal authenticated actions

1. In Backoffice, book all four planned operations: delivery 2 and installation 2 for each source line. Assign a crew, its responsible participant, transport and customer confirmation through the existing workflow.
2. In Crew, start the appointment as an assigned participant.
3. Report line `930011`: delivered 1, installed 0. Give delivery reason **Missing goods or parts** and installation reason **Access issue**, with clearly marked demo explanations.
4. Report line `930021`: delivered 0, installed 0. Give delivery reason **Damage** and installation reason **Other**, explaining that installation awaits replacement of the damaged chairs.
5. Complete required checklist, product checks, demo photos and signatures as required by the normal workflow. Submit once as the responsible participant. Customer signature remains required because the first line has one unit handed over.
6. In Backoffice History, verify each reason is attached to its own sales order, source line and operation despite matching SKU.
7. Verify remaining work independently: line `930011` delivery 1 / installation 2; line `930021` delivery 2 / installation 2. A follow-up appointment must offer only these remainders.
8. Negative checks: a missing reason for an unfinished planned operation must prevent submission; the other reason requires a note; completed or unplanned operations must not accept reasons. Normal authorization remains active.

Credentials stay in the existing ignored `.local/demo-accounts.json` and `.local/participant-demo-accounts.json`; do not copy them into documentation or logs. Existing images `.local/DEMO chair delivered.png` and `.local/DEMO table delivered.png` are demo assets only, not evidence of a real delivery.

## Executed acceptance — 2026-11-10

The source-only fixture was inserted into the local Docker stand. Booking, actual staffing, responsible participant, transport and customer confirmation used authenticated Backoffice HTTP commands. Start, the report, the uploaded teaching photo and both synthetic drawn signatures were submitted through normal Crew controls in Chrome; no execution facts were inserted directly into the database.

- Visit: `1f965258-fba2-4107-930a-eff220069320` (scheduled 12 November, 10:00–12:00 Europe/Rome; deliberately exercised early in this teaching test).
- Immutable result: `2a7d9100-eeab-49dd-a2c8-17abc8997cd5`; delivery version 9 after reporting.
- Line `930011`: delivery planned 2 / actual 1 / unperformed 1, missing goods; installation planned 2 / actual 0 / unperformed 2, access unavailable.
- Line `930021`: delivery planned 2 / actual 0 / unperformed 2, damage; installation planned 2 / actual 0 / unperformed 2, Other with explanation awaiting replacement.
- All four reasons and their individual notes appeared in Backoffice → Partially completed → DEMO/REASONS/0001 → History → Work recorded on this visit. The source order and line remained distinct despite identical product ID/name.
- Remaining freely plannable work is D1/I2 for order 9301 and D2/I2 for order 9302. No follow-up was automatically created. Damage does not yet impose a replacement-readiness hold; that is a separate planned workflow.
- Missing reason blocked submission and focused the correct operation; Other without a note also blocked submission. Completing an operation hid its reason; returning to partial restored its draft. Crew Refresh preserved all quantities/reasons/notes; History Refresh preserved the selected tab and scroll position.
- Existing Gianluca demo remained version 31; its original result-array MD5 stayed `38e2aad758c077aab3e11e4c30830ed1`. The new fixture did not overwrite its active appointment or historical report.
- Responsive layout checked at 390 px with no form horizontal overflow. Physical phones/camera/offline execution were not checked. Both browser tabs had no captured console errors.

Backend: **213/213** tests on isolated PostgreSQL; Backoffice **181/181**; Crew **28/28**. All project typechecks, typed lint and production builds passed. Backend/tools images were rebuilt, backend and importer restarted, and both frontend production servers restarted. A pre-demo database backup is in the ignored `.local/incomplete-work-before-20261110.dump`.

Run the backend stack with `docker compose up -d backend` and optionally `docker compose --profile importer up -d importer`; start `backoffice-frontend` and `crew-frontend` separately with `npm start` after their builds. Backoffice: <http://127.0.0.1:3000/>; Crew visit: <http://127.0.0.1:3002/visits/1f965258-fba2-4107-930a-eff220069320>.

Browser evidence: [History screenshot](../../backoffice-frontend/docs/screenshots/incomplete-work-history.jpg).
