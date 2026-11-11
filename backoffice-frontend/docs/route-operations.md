# Published route operations — stages 07–09

The Backoffice Routes page reads the live operational state from `/routes/:id/operations`. Current customer confirmations, next stop, stop reports, exact work, vehicle, driver, participants and actual departure/return are separate from the saved revision displayed in History. The original publication and later revisions are available through `/routes/:id/revisions/:version`.

Before departure, Francesca can review a changed departure time, stop order, work duration, customer windows, crew, actual participants, responsible participants, vehicle or driver. This keeps the same exact visits and booked work. Both “not departed” and “not loaded” attestations are required. The complete timeline and feasibility result are reviewed again; the UI names visits whose customer confirmations will reset. Applying requires acknowledgement of estimated travel times and a fresh fingerprint. Editing or Refresh invalidates that acknowledgement while preserving entries.

Cancellation requires a reason and the same attestations. By default, visits created by the route are cancelled and previously attached visits become standalone bookings. A separate unchecked selection explicitly cancels an attached visit. After departure the ordinary editor disappears; dispatchers use a reasoned skip or early-return action.

Actual return is independent from missing reports and warehouse acceptance. After return, the reconciliation table keeps exact appointment/source-line identities, including the same SKU on different orders. It distinguishes planned, reported, remaining and available quantities. Each remaining operation gets a next action and an accountable administrator/operator. Selecting the line owner pre-fills its operation owners. “Already planned” uses a select of eligible existing visits for the same delivery, line and operation.

Cargo starts as unknown; blank quantity is unknown, never zero. Warehouse acceptance is a separate command with positive quantities and its own receipt. Closing a route never closes its Pickings or invents crew reports, completed work, signatures or receipts. An explicitly documented exception is sent to the backend for validation against saved next actions and owners. Capability flags govern late follow-up reconciliation of exceptional closed routes.

History is read-only. Selecting a revision shows its frozen work/resource snapshots, operational event notes, declarations, acceptance receipts and closure exception. Current owner names may be resolved from the protected operator directory; immutable IDs remain available if that optional name lookup fails. A disappeared source line is explicitly labelled as a visit-snapshot remainder, with no planning availability.

All commands use existing authenticated HTTP requests, runtime validation, optimistic versions and stable request IDs for retries. The browser does not infer authorization from capability flags; the backend remains authoritative. Existing publication/readback 404 responses only disable the new controls. Publication availability comes from the backend capability, with local rollout recorded separately from isolated acceptance.

## Local verification and isolated browser

Run from `backoffice-frontend`:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

The isolated frontend uses the source-copy and startup commands in [route-publication.md](./route-publication.md), at `C:/Users/MOHD/AppData/Local/Temp/backoffice-publication-browser-20261111`, port 3010, with `NEXT_PUBLIC_API_URL=http://127.0.0.1:3011/api`. Synchronize the `src` directory before testing new changes. The stages 07–09 API uses the backend's ignored `.local/lifecycle-browser-demo/connection.json` manifest. A new API harness run creates new demo identities and credentials; restarting with `--resume` preserves that manifest, schema and existing facts. Never copy credentials into documentation.

The main `delivery_backoffice` database and backend containers are not migrated, reseeded or replaced by this isolated acceptance run.

## Verification on 11 November 2026

The complete frontend suite passed 206 tests. After the final returned-stop guard and wording changes, the focused lifecycle/publication suite passed 15 tests (nine lifecycle and six publication tests). A fresh typecheck, typed lint and production build also passed after those final changes. These checks cover exact same-SKU line identity, unknown cargo, independent receipts, optimistic versions, idempotent retries, amendment review invalidation, default attached-visit detachment, missing-report return, closure exceptions and the requirement to skip unstarted stops before closing. Refresh preserves mounted views and form drafts; an older response cannot overwrite a newer mutation.

Chrome acceptance used the actual isolated API and PostgreSQL data, not mocked UI responses:

- **Stage 08:** reordered the two stops of the attached-visit route, moved departure by one minute, increased work to 40 minutes, and reviewed the recalculated 78-minute schedule. Refresh retained the inputs and attestations while invalidating the old review. Applying produced revision 2 and reset both customer confirmations. Revision 1 retained the original order, times and confirmation. Cancelling with the optional attached-visit selection unchecked produced revision 3: the newly created visit was cancelled, and the attached visit remained booked for standalone planning.
- **Stage 09:** Crew recorded actual return separately from warehouse acceptance. Backoffice showed four distinct order lines sharing a SKU, each with one collected unit and one remaining unit. Assigning Francesca and a next action to each line did not create a receipt. Closure remained blocked until a separate warehouse command accepted one unit against each exact line. Cargo was then reconciled as at the warehouse, and the route closed at revision 8 without an exception. History retained the actual return, declarations, owners, next actions and all four receipt items.
- **Remaining work:** opening Picking `DEMO/PUBLISH/0301` after route closure still showed partially completed work: one unit collected, one remaining, zero reserved and one available for each of its two order lines. Delivery completion remained blocked. The untouched create-route fixture remains available for a later demonstration.

Evidence: amendment revision (`screenshots/route-amendment-history.png`), cancellation state (`screenshots/route-cancellation-history.png`), closure and warehouse receipts (`screenshots/route-closure-history.png`), remaining Picking work (`screenshots/route-remaining-work.png`). The final isolated Backoffice tab is `http://127.0.0.1:3010/`, Routes → closed collection route → History. These are local Chrome checks; physical-phone acceptance is not claimed here.

After the separately backed-up main backend rollout and frontend restart, a read-only Chrome check passed at `http://127.0.0.1:3000/` and `http://127.0.0.1:3002/routes`. Francesca can open publication preparation for an existing saved route. Its three attached work-line cards load; final review correctly remains unavailable until those older bookings have responsible participants. Nothing was edited or published during this check. Matteo's Crew account can open both My visits (five existing past visits) and My routes (an honest empty state, because no main route has been published for him). Fresh browser consoles contain no warnings or errors. Both application tabs remain open. Evidence: main publication preparation (`screenshots/main-route-publication.png`), main Crew routes (`screenshots/main-crew-routes.png`).

Screenshot paths refer to local verification artifacts intentionally excluded from Git.
