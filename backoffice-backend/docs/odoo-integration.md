# Separate local Odoo integration stand

This stand connects the backend to an explicitly approved Odoo 18 development copy using read-only access. Its application database and uploaded files are separate from the existing demo, restore checks and acceptance-test stands. It does not turn the current demo into a production deployment.

The application adapter owns the confirmed source field mapping and read-only session checks. Creating the infrastructure alone does not establish that source data has been imported successfully. Imports remain manual through the authenticated Backoffice flow. There is no polling importer service in this stand.

## Confirmed adapter contract

The inspected development copy reports PostgreSQL 16.1 and the Odoo base module version 18.0.1.3. The user confirmed that it contains fictional data and expects the future operational schema to be equivalent. Recheck that assumption before switching sources. Adapt this adapter to confirmed customer relationships; do not alter their Odoo schema to match the teaching fixtures.

| Application value | Inspected source |
| --- | --- |
| Picking identity and status | `stock_picking.id`, `name`, `state` |
| Sales team | `stock_picking.team_id` → `crm_team`, translated `name` |
| Recipient and delivery address | `stock_picking.partner_id` → `res_partner`; if absent, unanimous active move recipients must agree with every related order's shipping address, including the primary order |
| Exact Picking items | Active `stock_move` rows with this `picking_id`; `stock_move.id` is the stable source line identity |
| Order ownership of each item | Explicit `stock_move.sale_line_id` → `sale_order_line.order_id`; otherwise verified `stock_move.group_id` → `procurement_group.sale_id`, agreeing with the Picking and without a conflicting active sale-line order |
| Product and SKU | `stock_move.product_id` → `product_product`; `default_code` and translated `product_template.name` |
| Planned quantity and unit | `stock_move.product_uom_qty`; `product_uom` → translated `uom_uom.name`, retaining the UoM ID |
| Item description | `sale_order_line.name` when linked; otherwise the physical `stock_move.name` |

Translated names prefer nonempty `en_US`, then `it_IT`. Missing required names are diagnosed, not fabricated. Orders and identical SKUs remain separate because work belongs to a Picking and move ID, not to the SKU. A null sale-line link can resolve the order through the procurement group; it does not fabricate a commercial sale line. Missing, dangling or conflicting evidence still rejects the whole Picking. A non-null broken sale-line reference never falls back. The custom `sale_order_line.picking_id` relation is not used until its meaning is established.

Optional `saleOrderLineId`, `orderLinkBasis` and customer `addressSource` preserve how the adapter found the link. They do not backfill historical signed snapshots or change work fingerprints by themselves. An actual change of order, product, quantity, unit or destination still triggers the existing review rules. Recipient fallback copies one complete recipient record, never a mixture of shipping address and billing contact details; an explicitly specified Picking recipient remains authoritative.

This order-level relationship agrees with [Odoo 18's sale/stock implementation](https://github.com/odoo/odoo/blob/18.0/addons/sale_stock/models/stock.py): Picking's sale is computed from its procurement group. Odoo also permits physical moves without a sales line and can clear that line reference on product replacement. That supports the mapping, but does not establish why a particular customer move was created. Replacements are not automatically merged into the original item's remaining work.

The retained filters are outgoing, assigned, non-transit destination, no primary Magento order and the four agreed sales teams. The existing conservative exclusion of any linked Magento order is also retained pending source-contract reconciliation. Scans use keyset pages of 100 with a 5,000-Picking ceiling; per-Picking bounds are 500 items and 100 orders. Unsupported quantity precision is rejected instead of rounded. `stock_move.quantity` is not interpreted as completed customer work.

Service, on-site estimate, configuration, ambient, notes, photos and documents have no confirmed mapping yet and remain unknown. No prior delivery/installation completion or confirmed coordinates are invented. The application adds optional postal code, province, SKU and UoM identity to its JSON snapshots; no source migration is performed. Legacy signed snapshots and their fingerprints are preserved. Source identity namespaces imported records and saved entrances separately from `odoo_mock`.

The external connection starts read-only before ORM initialization, uses a repeatable-read read-only transaction, and checks effective administrative, CREATE and public table/column write privileges. Query timeouts are bounded. This is not a complete audit of executable functions or other schemas. No write probe is sent to the source.

## Isolation and addresses

| Item | Integration stand |
| --- | --- |
| Default Compose project | `delivery-odoo-integration` |
| Private configuration | `.local/odoo-integration/delivery-odoo-integration/` |
| Backend | `http://127.0.0.1:3031/api` |
| Backoffice origin | `http://127.0.0.1:3030` |
| Crew origin | `http://127.0.0.1:3032` |
| Internal PostgreSQL | `db:55432`, no host port |
| Local application DB | `delivery_backoffice` |
| Local test DB | `delivery_backoffice_test` |
| Empty local mock DB | `odoo_mock`, retained for the common bootstrap contract |
| Images | `delivery-odoo-integration-backend:0.1.0`, `delivery-odoo-integration-tools:0.1.0` |
| Data volumes | Project-owned `pg-data` and `app-data` |

The existing Dockerfile, PostgreSQL initialization script and roles SQL are reused. The DB joins only an internal network. Application services also join a separate network to reach the approved source. Source credentials use mounted Docker secrets; they are not Compose environment values or image build arguments. The application’s local database credentials are generated separately, never copied from the main demo.

## Configure without starting or connecting

Run from the backend directory using PowerShell 7, installed project dependencies, Docker Desktop with Linux containers and Docker Compose. The examples below contain placeholders only.

Keep the supplied source password in an ordinary private local file outside version control, or supply it via the process environment variable `BACKOFFICE_ODOO_SOURCE_PASSWORD`. Do not put the password in command arguments, reports or tracked files.

```powershell
./scripts/docker-odoo-configure.ps1 `
  -SourceEndpoint 'postgresql://source.example.test:15433/customer_snapshot' `
  -SourceUser 'source_reader' `
  -SourceInstance 'customer-development-copy' `
  -SourcePasswordFile 'C:/private/source-password.txt'
```

TLS with certificate verification is the default. For a private CA, add `-SourceCaFile 'C:/private/source-ca.pem'`. The CA is copied into the stand’s private configuration and mounted read-only.

If the explicitly approved local development source does not support TLS, use its exact `.local` hostname or RFC1918 IPv4 endpoint and add both `-Transport internal-lan -ApproveInternalLan`. This connection is unencrypted and is a local-test exception. It is not the future production connection policy.

If Docker cannot resolve the approved `.local` hostname, add `-SourceAddress '192.168.50.10'` using its verified private IPv4 address. This creates an `extra_hosts` entry for that exact source hostname on application containers only; it keeps the approved URL unchanged. This option is limited to the explicit internal LAN mode and RFC1918 addresses. A later address change requires inspection of the saved configuration.

Configuration uses the actual application validator without making a source connection. It refuses destination overrides, missing identity/reader approval, conflicting existing Docker resources and reused project names belonging to another source. Private files receive restricted permissions; existing configuration is checked and retained without replacing passwords. A changed configuration requires inspection, rather than automatic overwriting or credential rotation.

```powershell
./scripts/docker-odoo-start.ps1 -ValidateOnly
```

The validation command checks configuration hashes, Compose validity and existing volume/network ownership. It does not build images or start services. The scripts never reset databases or delete Docker volumes.

## Build and start the separate backend

```powershell
./scripts/docker-odoo-start.ps1
```

This builds only the integration image tags, starts the isolated DB, applies application migrations there and waits for the backend health check. The main demo project is not a target of these commands. Startup does not seed users or import Odoo rows.

For explicit one-shot administration, always select this generated file and project:

```powershell
$odooCompose = @(
  '--project-name', 'delivery-odoo-integration',
  '--file', './.local/odoo-integration/delivery-odoo-integration/compose.yaml'
)
docker compose @odooCompose ps
docker compose @odooCompose run --rm --no-deps tools npm run seed
```

The optional seed creates synthetic application accounts, crews and task templates in this stand only. Credentials are stored inside its `app-data` volume as `/app/.local/demo-accounts.json`. It does not seed or write to the external source. Arrange authenticated manual import after the source adapter and its read-only checks have passed; do not run the old watch importer against the source.

Frontend processes are started separately on ports 3030/3032 with `NEXT_PUBLIC_API_URL=http://127.0.0.1:3031/api`. They need separate Next.js development output directories from the demo interfaces, so parallel processes do not share build artifacts. The backend origin allowlist permits these ports only in explicit Odoo 18 mode.

## Verification recorded for the infrastructure template

On 2026-11-12, PowerShell parsing, application config validation and `docker compose config --quiet` were checked with a synthetic source endpoint and password. The `-ValidateOnly` path was exercised without starting any service. These checks prove configuration validity, not source connectivity, migrations, imported field correctness or frontend behavior; actual integration verification must be recorded separately after execution.

## First development-copy connection · 2026-11-12

Historical first-import results follow. The 274 rejected Pickings were subsequently recovered by the verified procurement-group and recipient mappings described below.

The actual isolated project is `delivery-odoo-customerdev`; pass `-ProjectName delivery-odoo-customerdev` to the scripts. Its private configuration, application login file and verification reports are in `.local/odoo-integration/delivery-odoo-customerdev/`. The source connection is a different credential from those application accounts. API 3031 is healthy; 13 existing application migrations ran on this stand's own PostgreSQL 18.6 volume. The main demo, acceptance and restored stands were preserved.

An authenticated manual HTTP import read 790 qualifying Pickings from the customer-schema development copy in approximately 30 seconds. It imported 516 and reported 274 validation failures: 273 Pickings contain a move without an explicit order-line relation, and one lacks a recipient. The 302 unlinked moves also have no populated custom `sale_order_line_id`, `linked_order_origin_sale_id`, `linked_order_origin_picking_id`, `origin_returned_move_id` or predecessor move-chain link. These alternate relationships therefore do not justify an inferred mapping. Confirm their business meaning with the source owner before importing them.

A second authenticated import produced the same 516 records and diagnostics. An aggregate comparison of all delivery IDs, versions and JSON content was identical; no duplicates, phantom updates or invented geographic points appeared. The HTTP Inbox returns 516 total items with the normal 10-row pagination. Imported rows use the separate `mohd_odoo_dev` source identity.

Backend typecheck, typed lint, build and 285 tests passed; the subsequently expanded namespace-isolation importer suite passed 10/10 on owned PostgreSQL schemas. Backoffice typecheck, typed lint, build and 212 tests passed. The isolated Backoffice production copy was built with API 3031 and serves port 3030 from `../backoffice-frontend/.local/odoo-integration/frontend`; its runtime manifest is in the parent directory. Restart it from that copy with `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3030`. Crew 3032 is an allowed origin only and has not been started for this source stand.

This verifies the first partial integration, not the complete customer data contract. Service/time/documents, earlier completed work, packaging and any multi-address custom semantics still need reconciliation. The local seeded crews/templates are application demo data, not imported Odoo crews. Routes retains explicitly marked demo depots and estimated travel times.

Chrome verification used the normal operator login: Inbox 516/10-row pagination, read-only customer-schema badge, destination and SKU in a delivery card, city/province/postal-code cascade, and Source sync with two partial runs and 274 visible diagnostics all passed. Chrome was left on Inbox 3030. Screenshots are in the private stand directory as `browser-odoo-{inbox,delivery,imports}.png`. The separate browser Refresh-state check timed out and remains unverified; it is not included in this success claim.

## Reconciliation of all 274 rejected Pickings · 2026-11-12

Deeper source inspection found an authoritative relationship omitted by the first adapter: all 302 moves without `sale_line_id` belong to a `procurement_group` whose `sale_id` matches the Picking's order. Both links are actual PostgreSQL foreign keys. None of the 790 qualifying Pickings had a contradictory active sales-line or procurement-group order. This resolves order ownership, while the exact commercial sales line remains absent. No SKU matching, bundle expansion or invented sales line is performed.

Two Pickings lack their header recipient. In both, every active move's recipient agrees with the sales order's shipping address. The guarded fallback imports that complete partner record. One of these Pickings was previously counted among the 273 line errors, so the total number of recovered Pickings is 274, not 275.

The rebuilt separate Docker API imported **790/790 Pickings successfully, zero diagnostics** in approximately 45 seconds. The previous 516 application IDs and all their non-source operational fields were preserved. A source-to-application checksum matched the identities, products, quantities, UoMs and order IDs of all 302 recovered physical moves. A second full import kept all 790 IDs, versions and JSON snapshots byte-identical. Historical partial import logs remain as history. Backend typecheck, typed lint, build and all **291 tests** passed; adapter regression tests use an isolated local PostgreSQL schema, never the external source.

The source still has **no usable coordinates for these 790 destinations**: the relevant latitude/longitude pairs are absent or `(0,0)`. Related shipping, parent and commercial contacts do not provide usable alternatives. The earlier demo pins were explicitly seeded and are isolated to `odoo_mock`. Text addresses alone cannot place map markers. The map now explains this for the Odoo workspace in all four languages and keeps its address list accessible; no geocoder was activated and no customer address was sent to Google or another geocoding service. Three imported destinations also lack a city and need authoritative address completion before entrance confirmation.

The remaining source-owner questions are recorded in Notion task 13: the business meaning of physical products absent from commercial order lines, Picking-versus-route terminology, and the source/quality of address coordinates. These no longer block reading the confirmed order relationships.

The updated Backoffice passed typecheck, typed lint, both production builds and **217 tests**. ESLint excludes the generated `.local` runtime mirror; authoritative source, tests, scripts and configuration stay checked. In Chrome, normal operator login showed 790 deliveries, the recovered product/order/move identity, both restored recipients and Map 0/790 with the Odoo-specific explanation. Map Refresh retained the map DOM, selected view and missing-coordinate list scroll. An additional city-filter browser selector check did not complete and is not claimed as verified in this run. Chrome was left on the unfiltered Map; runtime metadata and bounded browser evidence are in the private integration directories.

## Text-address geocoding · 2026-11-12

The earlier zero-marker result above is superseded for Partner 233774. Its current source address is `Via F.Faranda 19`, while the other 789 imported street addresses remain placeholders. The source still supplies no usable coordinates. The authorized Geoapify integration now stores address coordinates in the application database, with no Odoo writes; Chrome and authenticated API checks verified **Map 1/790**. Commands, caching, attribution, precision rules, verification evidence and the current generated frontend location are documented in [geocoding.md](geocoding.md).

Automatic geocoding is now part of the ordinary import: after the source snapshot ends, a bounded phase locates eligible uncached addresses and reports its outcome in Import history. Placeholder addresses and existing coordinates consume no provider requests. Two live repeat imports each processed all 790 records with 789 skipped placeholders, one reused map point and no increase in provider usage. Approximate matches still require review; deferred work is reconsidered on the next import. See the geocoding runbook for processing limits and the repeat-import verification command.

## Application-owned line services and work times

Missing services and operation durations can be entered in Backoffice per exact Picking line, with local provenance and preservation across source imports. Quantity changes rescale the estimate; product/order/unit/address changes require review. Inbox, Nearby and Routes use the same remaining-work calculation. See [line-work-times.md](line-work-times.md) for units, ownership rules, repeat-import checks and the separate three-address browser demonstration. These entered rates are teaching assumptions until approved by the customer.

## Instructions and drawings audit · 2026-11-16

Task 15 checked the source development copy through the approved PostgreSQL reader in a read-only transaction. The checked cohort was 790 Pickings and 1,325 active physical moves. Of those moves, 1,023 have explicit sales-line links, covering 1,011 distinct sales lines. Only metadata, associations and grouped counts were read. No attachment bytes or storage credentials were extracted.

| Candidate | What is present in the checked copy |
| --- | --- |
| Exact sales line → document | `sale_order_line_product_document_rel → product_document.ir_attachment_id → ir_attachment` exists, but the relation is empty even outside the cohort. There are no direct `stock.move` or `stock.move.line` attachments for these Pickings. |
| Other direct attachments | The 184 linked `sale.order.line` attachments are all for `prev_image`. Picking and order attachments include PDFs, but are linked to the header rather than to the delivered item. These references have no file bytes in `ir_attachment.db_datas`. |
| Product document and Documents app | One of the 76 `product_document` records matches a cohort product variant, as a product PDF without a line association or database bytes. `documents_document` has 353 records and no confirmed direct match to the cohort. |
| Customer configuration, linked from an exact order line | `stock_move.sale_line_id → sale_order_line.product_conf_id → product_configuration_attachment.product_conf_id`. There are 92 linked moves in 62 Pickings. Three linked PDF attachments are classified as `scheda_tecnica` (technical sheet); none is classified as `istr_montaggio` (assembly instructions). |
| Customer configuration, matched through the product variant/template | The product references reach 259 configurations and 27 PDF attachments, including eight labelled `istr_montaggio`, 18 technical sheets and one unclassified PDF. The match establishes a product configuration, not the approved instructions for a specific sales line. The configuration's separate `installation_instructions` text/URL field is empty in the cohort. |

In [standard Odoo 18](https://github.com/odoo/odoo/blob/18.0/odoo/addons/base/models/ir_attachment.py), `store_fname` refers to the server filestore; a PostgreSQL reader alone cannot read those bytes. A typed link to a known product document still does not establish that it is the instruction for a particular configured order line.

The matched custom attachments have Odoo filestore pointers and Cloudflare storage keys, with no `db_datas` bytes. A global check found 5,106 `istr_montaggio` records (5,092 PDFs), also without database bytes. One directly linked move's sales-line configuration differs from both its product variant and template configurations, so product-level fallback could expose the wrong document. Together with the lack of a confirmed line-level instruction or drawing, this leaves task 15 blocked on source data and file access. No document was imported, and no key or URL was followed. The [existing private document/version workflow](document-versioning.md) remains available for Backoffice uploads and assigned Crew reads; its isolated PostgreSQL tests passed 10/10 and the Crew line-document tests passed 4/4.

Ask the source owner for one test Picking with an approved PDF instruction or drawing and the exact related move, sales-line or accepted configuration IDs; if variant/template inheritance is intended, confirm that rule explicitly. Ask for the sample file plus its attachment ID and revision/checksum, or a scoped read-only download method for those files. Preserve the source revision and private access in the application rather than exposing storage keys in Crew.

## Delivery filters on the working stand · 2026-11-16

The **delivery-odoo-customerdev** Docker backend was rebuilt and replaced with its existing base and geocoding Compose files using `up --detach --no-deps --no-build --wait backend`. The existing PostgreSQL container and volumes were kept; all 19 configured migrations were already installed. No migration, import or seed ran during this rollout. The previous API image is retained under the rollback tag in the ignored `filters-backend-rollout.json`.

The Backoffice production build now runs from `backoffice-frontend/.local/odoo-integration/frontend-delivery-filters-20261116`. It was built with `NEXT_PUBLIC_API_URL=http://127.0.0.1:3031/api` and started from that directory with `npm start -- --port 3030`. Its process details are in the ignored frontend runtime manifest.

Before browser verification, the read-only snapshots matched for all 37 application tables, including all 790 delivery records and their versions, 1,403 audit events, both file records and both private files on disk. The authenticated working API accepted and applied the Assigned search filter, and Chrome showed the filters at `http://127.0.0.1:3030/?view=assigned`. Assigned has no deliveries on this data set; the panel remains visible.

The catalogue correction updates only Docker backend `3031` with the same Compose files and `--no-deps`; frontend `3030` accepts the updated counts with no rebuild. Existing application table and file checksums matched again. In Chrome all seven operational tabs offered catalogue choices on the working stand. Assigned kept zero results while accepting Messina, ME, 98123 and Messina Uno; Completed returned one delivery for that combination and zero when the team changed to Catania Uno. The ignored `facets-catalogue-rollout.json` records the rollback image and Compose files for this deployment.
