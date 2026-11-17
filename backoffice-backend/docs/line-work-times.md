# Local services and product-line work times

When Odoo does not supply operational services or work times, the dispatcher maintains them in Backoffice. Source fields stay read-only. Open a delivery, choose its default or individual product service, then use **Edit work times** in the product line.

Each operation accepts an integer from 1 to 1440 minutes per source unit. These are elapsed minutes for the whole team, excluding travel. They are not person-hours and are not divided by the number of participants. A blank value means unknown; clearing all three values removes the local time override. Only operations required by the line's current service can be entered.

The base estimate multiplies the remaining delivery, installation and collection quantities by their respective rates and adds their elapsed times. Completed work is excluded. Booking and route scopes use their own selected quantities. The server retains the exact fractional total until applying any site factor, then rounds up to a whole minute. The same estimator supplies Inbox, Nearby work and Routes. Route travel remains explicitly approximate without a road provider.

## Ownership and reimport

Local settings belong to the application's delivery and exact source move ID, not to SKU. Two identical products from different orders therefore keep separate services, quantities and rates. They are stored in the existing versioned delivery JSON and audit history; no database migration or source write is needed.

Normal reimport replaces the source snapshot while preserving local service overrides and time rates. A quantity change rescales the result. A changed product, owning order, unit or destination preserves the entered rates but makes them stale until reviewed and saved again. A replacement move ID does not inherit the old move's rates by SKU. Historical signed reports and published route snapshots stay unchanged.

If a required operation has neither a usable local rate nor a usable source estimate, its duration is unknown. An old aggregate source estimate can supply only the existing proportional approximation, explicitly labelled as such; it is not presented as a genuine per-line Odoo rate. Local, source-proportional and mixed estimates have distinct labels. A stale local rate never silently falls back to a fresh-looking source estimate.

Saving uses `PATCH /api/deliveries/:id/work-times` with the current delivery version and exact source line ID. Normal operator/admin authorization, source-review guards, in-progress work restrictions and optimistic concurrency apply. Changing rates changes the route work fingerprint so a previously reviewed duration requires review.

## Site adjustments and fixed work

The delivery-level work-time adjustments extend the existing rates. The operator records a percentage for variable work, fixed minutes per visit, and separate fixed minutes for delivery, installation and collection. These inputs describe elapsed time for the whole team. Their source and assumptions explain which preparation, unloading, access, parking or waiting they cover. Company standards still require operational confirmation.

The calculation first sums only the selected remaining quantities multiplied by their operation rates, applies the percentage, and rounds up once. It then adds the visit allowance once and each selected operation's fixed allowance once. Several product lines do not multiply these allowances. A later installation-only visit includes the visit and installation allowances. A visit with no selected work takes zero minutes.

The Inbox total treats the outstanding work as one candidate visit. Each separately planned visit uses its own selected scope and receives its own visit allowance. Splitting work between visits therefore changes the combined fixed time.

For example, two delivery units at 10 minutes and one installation unit at 30 minutes give 50 base minutes. A 125% factor gives 63 rounded minutes. Adding 5 visit minutes, 4 delivery minutes and 8 installation minutes gives 80 minutes. A later visit for one installation unit gives 38 variable minutes plus 5 visit and 8 installation minutes, or 51 minutes. These numbers illustrate the arithmetic and are not approved company norms.

Save through `PATCH /api/deliveries/:id/work-time-adjustments` with the current delivery version, a request ID and a reason. The saved settings retain their own version, source, assumptions, author, time and reviewed site-context fingerprint. Null means unknown. Zero explicitly means no fixed allowance, and 100% leaves variable work unchanged. Missing allowances for unselected operations do not prevent a calculation. Missing inputs for selected work make its total unknown.

Existing deliveries without adjustments retain their base estimate with an explicit base-only status. Configured adjustments require review after the destination or access instructions change. Non-neutral additions to a proportional source estimate also require the operator to confirm that the source estimate excludes those additions. This confirmation prevents silently counting the same work twice.

Delivery details, Inbox, Nearby and Routes use the same server result and expose the calculation version, base time, factor, fixed time and total. Per-line values show variable work only. Route work fingerprints include applied adjustments and the reviewed site context. A manual route duration stays selected until the operator explicitly changes it. Saved publication and signed-report snapshots retain their recorded values.

## Verification and demonstrations

`test/work-times.test.ts` and the HTTP tests cover domain arithmetic, remaining work, validation and authorization. `test/importer.test.ts` verifies reimport and source changes on isolated local PostgreSQL schemas. Frontend tests cover contracts and the per-line editor. Run the normal project typecheck, typed lint, tests and build.

`scripts/demo-line-work-times.ts` prepares a separate persistent browser demonstration with three Picking records and one identical SKU across different orders. It uses owned test/source schemas, public Catania reference addresses from `local/public-demo-addresses.json`, synthetic quantities and explicit teaching rates. It does not assign fake coordinates to customer-source placeholders. Its private manifest and non-secret results live under `.local/line-work-browser-demo/`.

The explicitly authorized customer-schema development stand has a second repeat-import scenario:

```powershell
./scripts/verify-local-work-times.ps1
```

This command is restricted to `delivery-odoo-customerdev` on API 3031. It requires the three named, unbooked, single-line fixtures to retain their expected identities and quantities. It preserves existing service decisions, adds explicit teaching rates only through normal authenticated application endpoints, reimports Odoo read-only, and checks the resulting route job estimates. It refuses different existing services or rates. Original application details and a verification report are saved privately in that stand's `.local` directory. The rates are demo assumptions, not approved customer standards.

Expected source-copy results: `MTO/OUT/00697` delivery plus installation = 30 minutes; `MTO/OUT/00893` collection = 25 minutes; `MTO/OUT/00973` delivery = 15 minutes. Only the first has a usable non-placeholder address at present. The separate three-address demonstration exercises geographic Nearby and the complete route schedule.

## Recorded verification · 2026-11-12

The customer-development API was rebuilt and restarted with its existing geocoding configuration. Authenticated reimport succeeded for all 790 Pickings; all three local plans and rates remained identical, and Routes returned 30/25/15 minutes. No external source writes were made. Existing main, acceptance and restored APIs remained healthy.

The isolated demonstration verified 60/45/25-minute stops, two Nearby matches plus the anchor within 5 km, unchanged data on reimport, and a 130→140→130-minute route recalculation. Increasing the first line's installation rate from 20 to 25 minutes per unit moved the estimated return by ten minutes. The route is a draft: resources are unassigned and road travel is approximate. Creation/resume commands are in [line-work-demo.md](line-work-demo.md).

Chrome on port 3010 verified all three Inbox estimates, Nearby at 5 km, editing and saving the first line's installation rate, 60→70→60-minute remaining work, and preservation of an unsaved rate/open editor/scroll on Refresh. The saved route was opened; its accessible schedule showed departure 09:00, work durations 60/45/25 and 130 minutes total work. Computer Use stopped while locating the timeline visually because it could no longer determine the browser URL reliably; no further browser input was attempted. Routes remains open. The customer-source Backoffice runs on port 3030.

Backend typecheck, typed lint and production build passed. The complete PostgreSQL-backed run reported 337/339: an empty-source regression and its parent-suite failure were corrected; the entire affected scope plus final work-time/OpenAPI checks then passed 12/12. The new HTTP tests passed, including authorization, concurrency, remaining scopes, published-route immutability and signed report preservation. Importer regressions passed 13/13. Frontend typecheck, typed lint, 230/230 tests and both configured production builds passed. No claim of a second all-green full backend run is made.
