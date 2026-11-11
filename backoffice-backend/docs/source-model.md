# Fake Odoo: local teaching source

Source requirements: [Delivery Backoffice plan v0.2, 2026-11-03](https://app.notion.com/p/40c4433fac0f815ab7e5fb9257f22047).

This deliberately small PostgreSQL model uses synthetic people and products. It does **not** establish compatibility with the customer's Odoo version, schema, custom fields, translations, or real data. In particular, `crm_team.name` is text here; its real type and localization must be checked when read-only customer access is separately authorized.

## Local PostgreSQL

Docker Compose is the current default; see [docker.md](docker.md). Its PostgreSQL 18.6 container serves all three databases, published only on `127.0.0.1:55433`. Seed/verification are explicit commands, separate from API/importer startup:

```powershell
docker compose exec -T --user postgres db bash /opt/backoffice/docker/source-setup.sh
docker compose exec -T --user postgres db psql -U backoffice_local_admin -d odoo_mock -v ON_ERROR_STOP=1 -f /opt/backoffice/local/source-assertions.sql
```

The source setup uses the isolated `odoo_seed` account; the application/importer receive only `odoo_reader`. Never execute source setup against a real client database. Source setup adds missing deterministic teaching records and does not reset edited records.

The following Windows commands are **legacy native-cluster commands**. The preserved native cluster is stopped while Docker is active. PostgreSQL 18 Windows binaries are expected at `C:/Program Files/PostgreSQL/18/bin`; the scripts use PowerShell 7:

```powershell
./scripts/postgres-setup.ps1
./scripts/postgres-verify.ps1
```

Use `-PostgresBin 'your/path/to/bin'` if needed. This starts an independently owned cluster under `.local/postgres`, bound only to `127.0.0.1:55432`; it does not use or change any installed PostgreSQL service. A marker and the actual server data directory are checked before setup/verification. An occupied port or unmarked directory causes a stop. The scripts never stop other PostgreSQL instances or delete/reset a cluster.

The setup creates three databases, generates random passwords into ignored `.local/postgres-credentials.json`, and creates `.env` only if absent. Do not commit either file or copy those credentials into documentation. `DATABASE_URL` is the application writer, `TEST_DATABASE_URL` points to the separate test database, and `ODOO_DATABASE_URL` uses the source reader. Restart the owned server with `./scripts/postgres-start.ps1` after reboot. The server must run while the backend is in use.

| Database | Owner / writer | Application access |
| --- | --- | --- |
| `odoo_mock` | `odoo_seed` | `odoo_reader`: CONNECT, schema USAGE, table SELECT only |
| `delivery_backoffice` | `delivery_app` | Application migrations and runtime writes |
| `delivery_backoffice_test` | `delivery_app` | Isolated integration test target |

The source reader is not superuser, cannot create databases/roles/schema objects, has default read-only transactions, and cannot connect to the application database. The verification also explicitly turns off its transaction read-only setting and checks that a harmless zero-row UPDATE is still rejected by table privileges. Migrations must never receive `ODOO_DATABASE_URL`.

## Deterministic data and expected filters

The seed contains 30 pickings, 12 partners, 31 sales orders, and 61 stock moves. A second seed inserts only absent stable IDs, preserving deliberately changed scenario data. It neither deletes unrelated data nor silently restores edited records. Fixture assertions expect the initial source state, so they correctly report a difference after a mutation scenario.

`local/source-filter.sql` preserves the five original INNER JOINs and their SQL NULL behavior. Following the user's multi-order clarification on 2026-11-04, it also excludes a picking if any order linked through its actual stock moves has a non-null Magento ID. This conservative extension prevents silently importing part of a mixed picking; it is a documented teaching assumption pending customer-schema validation. On the initial fixture, exact qualifying picking IDs are **1 through 20 inclusive**. Every admitted source picking remains an individual local Delivery.

| Picking ID | Initial exclusion |
| --- | --- |
| 21 | incoming operation |
| 22 | source state done, not assigned |
| 23 | destination `My Company: Transit Location` |
| 24 | sales order has non-null `magento_id` |
| 25 | sales team outside allowlist |
| 26 | destination name NULL; `<>` evaluates UNKNOWN |
| 27 | NULL team reference; INNER JOIN fails |
| 28 | NULL sale reference; INNER JOIN fails |
| 29 | NULL picking-type reference; INNER JOIN fails |
| 30 | NULL destination reference; INNER JOIN fails |

Pickings 1 and 2 both belong to sales order 1 but have distinct stock moves `[11,12]` and `[21,22]`, so importing all sales-order lines would be incorrect. The same product template has Oak/180 cm and Walnut/220 cm configurations with distinct product/line IDs. Move 52 is **1.500 m**, demonstrating decimal quantities. Picking 12 has deliberately missing address/contact/planning data. Missing product photographs are NULL rather than fabricated URLs.

## Several sales orders in one picking

The user explicitly confirmed on 2026-11-04 that one picking can combine several sales orders. A sales order may also be split across several pickings. Commercial orders are read-only context; a Delivery is still one picking, with many visits and independently staffed follow-up visits.

The teaching adapter derives the complete order list from the primary `stock_picking.sale_id` reference **and** `stock_move.sale_line_id → sale_order_line.order_id`. It imports only moves belonging to the picking, never every line of a commercial order. New snapshots contain `salesOrders: [{id,name}]`; each item contains its actual `saleOrderId`. The old singular `saleOrderId`/`saleOrderName` fields remain the primary compatibility reference. Legacy signed snapshots do not acquire invented order lists or line ownership.

Picking **20** demonstrates orders **20 and 1001**: existing moves **201/202** belong to order 20; additional move **20001** belongs to order 1001. The additive seed preserves all previous records and IDs. This model uses the picking's one destination/contact; order billing customers are not substituted for the delivery recipient.

Issues, evidence and delivered quantities refer to stable **stock-move IDs**, so a problem can identify a line of a particular order even when products repeat. A missing line can be delivered by another crew on a follow-up visit without counting the first order twice. Closure still requires every picking line, mandatory work, issues, return requests and confirmations to be complete. These are local records; no commercial order is created or updated in Odoo.

Changing the order set or a line's order owner after booking requires source review alongside address/quantity changes. Historical results and closure snapshots stay unchanged. Source absence/invalid data retains the last valid snapshot, rather than dropping an inconvenient line or order.

## Field provenance

Names resembling Odoo are a minimal teaching convention, not a verified customer mapping. Backend code should select an explicit allowlist, treat rows as untrusted, and validate before import.

| Fields | Source and meaning in this model |
| --- | --- |
| `stock_picking.id,name,state,picking_type_id,location_dest_id,team_id,sale_id` | Five-table relationship/filter described in plan; source assigned is distinct from local crew assignment |
| `stock_picking.partner_id,scheduled_date,write_date` | Minimal unverified source mapping; scheduled date is not a local appointment |
| `stock_picking.demo_service_type,demo_estimated_minutes,demo_notes` | Explicit synthetic extensions, not standard Odoo claims |
| `stock_picking_type.code`, `stock_location.name`, `crm_team.name`, `sale_order.magento_id` | Exact filter inputs described in plan; team is a sales team, never a delivery crew |
| `sale_order.name,partner_id,write_date` | Synthetic sales-order context; no order creation API |
| `res_partner.name,street,city,country_code,phone,mobile,email,contact_name` | Minimal synthetic delivery contact mapping; `contact_name` and country representation are unverified assumptions |
| `product_template.name,description,image_url` | Synthetic product reference; `image_url` is an unverified nullable model field |
| `product_product.product_tmpl_id,default_code` | Synthetic model/variant relation and SKU |
| `sale_order_line.order_id,product_id,name,product_uom_qty,product_uom` | Minimal synthetic order-line context; not the delivery quantities authority |
| `sale_order_line.demo_configuration,demo_ambient,demo_notes` | Explicit teaching extensions; NULL remains unknown |
| `stock_move.id,picking_id,sale_line_id,product_id,name,product_uom_qty,product_uom,write_date` | Stable delivery-line identity and picking-specific quantities; no operational move-line detail is needed |

Appointments, crew/people, task templates/instances, local access instructions, issues, return requests, evidence, signatures, and history belong only to the application database.

## Mutation and outage scenarios

Automated integration scenarios should use a separate owned schema/database or restore only their exact changed fixture rows in a `finally` block. Change related partner street, move quantity, sales team name, sales-order `magento_id`, or picking source state independently; a picking timestamp alone cannot detect those changes. A tracked picking that no longer qualifies is retained and marked for review, never deleted or locally completed. Repeat import must preserve appointments and prior signed snapshots.

To test source unavailability, use a deliberately unreachable connection for the isolated importer test, then restore the real connection and rerun. Do not stop another server or damage database files to create an outage. A paused/failed importer must record failure and be restartable through its normal domain path.

This script is additive setup, not a reset/restore command. Recovery of existing application data and private files must follow the application backup instructions; do not run `initdb` over existing data or delete `.local` as a debugging shortcut.

PostgreSQL API references checked for version 18: [initdb](https://www.postgresql.org/docs/18/app-initdb.html), [GRANT](https://www.postgresql.org/docs/18/sql-grant.html), [ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html).
