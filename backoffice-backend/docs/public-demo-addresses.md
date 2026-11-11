# Public addresses for the local demo

On 2026-11-09 the user requested replacement of **all** fictional `Via Dimostrativa` addresses. The eleven replacement destinations are real public venues in the original cities. Demo customers, orders and deliveries remain fictional; the venues are not customers. Customer 12 has no street and remains the incomplete-address example.

The authoritative fixture is [`local/public-demo-addresses.json`](../local/public-demo-addresses.json). Every record includes the official address source, coordinate source, check date and `building_reference` accuracy. Coordinates identify buildings or grounds, **not verified unloading entrances**. Official postal addresses take precedence over approximate surrounding postcode areas inferred by a map provider. No Google API, billing key or live geocoding service is used by the seed or Inbox proximity calculation.

| Original street | Replacement venue | Public address | City / province / CAP |
| --- | --- | --- | --- |
| Via Dimostrativa 1 | Orto Botanico ed Herbarium | Via Etnea 397 | Catania / CT / 95125 |
| Via Dimostrativa 2 | Palazzo Zanca | Piazza Unione Europea | Messina / ME / 98122 |
| Via Dimostrativa 3 | Museo Vincenzo Bellini | Piazza San Francesco d'Assisi 3 | Catania / CT / 95124 |
| Via Dimostrativa 4 | Museo Regionale Accascina | Viale della Libertà 465 | Messina / ME / 98121 |
| Via Dimostrativa 5 | Teatro Massimo Bellini | Via Giuseppe Perrotta 12 | Catania / CT / 95131 |
| Via Dimostrativa 6 | Teatro Vittorio Emanuele II | Via Giuseppe Garibaldi | Messina / ME / 98122 |
| Via Dimostrativa 7 | Città della Scienza | Via Simeto 23 | Catania / CT / 95131 |
| Via Dimostrativa 8 | Palazzo Satellite | Piazza della Repubblica 1 | Messina / ME / 98122 |
| Via Dimostrativa 9 | Museo Civico Castello Ursino | Piazza Federico II di Svevia | Catania / CT / 95121 |
| Via Dimostrativa 10 | Palazzo Weigert | Via Argentieri 12 | Messina / ME / 98122 |
| Via Dimostrativa 11 | Palazzo della Cultura | Via Vittorio Emanuele II 121 | Catania / CT / 95131 |

## Repeatable local update

Run from `backoffice-backend` after initial database setup, migration, account seed and import. For an existing stand, first stop writers and capture the existing joint database/file backup. Do not reset volumes or rerun destructive setup.

```powershell
docker compose --profile tools build tools
docker compose stop backend importer
./scripts/docker-backup.ps1 -WritersStopped
docker compose --profile tools run --rm tests npx tsx scripts/demo-public-addresses.ts --apply
docker compose --profile importer up -d --no-deps backend importer
```

The `tests` service is used only as a tools runner here: it also mounts the existing **local fake-source owner secret**. This does not run the test suite or change the runtime adapter's credentials. Runtime import continues using `odoo_reader`, with read-only transactions and SELECT permissions.

The script refuses production mode and checks the local PostgreSQL host, port, database, schema and fixture identity. It updates only the eleven matching `odoo_mock.res_partner` streets, authenticates the demo operator and invokes the normal importer. The importer invalidates old address-bound coordinates/geography and records source changes. Then the script supplies missing reference coordinates and province/CAP for the exact new destinations, with source links in audit events. The existing metadata discriminator remains `synthetic_fixture`, because these are teaching fixtures, even though the referenced locations are real.

Changed fixture identities and user-edited destinations are skipped. Existing coordinates/geography for an already-matching real address and confirmed entrances are preserved. Repeating the command does not change delivery versions or add duplicate reference events; ordinary authentication/import bookkeeping can still create its normal audit entries. If interrupted between source maintenance and import, rerun the command.

Appointments, staffing, transport, customer confirmations, quantities, results, signatures, files and route drafts retain their existing records. Previously booked deliveries can show the existing **source changed** warning and require dispatcher review. Old confirmed entrances and route-specific points remain in storage/history but are not valid for a different address key. This update does not invent new customer confirmation or verify access for a delivery vehicle.

The older [coordinate](nearby-work-demo.md) and [geography](geography-demo.md) population commands remain for original isolated fixtures. Their historical radius and CAP examples do not describe this updated stand. They deliberately skip the new addresses.

## Verification

```powershell
npm run typecheck
npm run lint
npm run build
docker compose --profile tools run --rm tests npx tsx --test --test-concurrency=1 test/demo-public-addresses.test.ts
```

Database tests use dedicated application/source schemas, real PostgreSQL, the normal importer and the read-only source role. Check the live map at `http://127.0.0.1:3000/?view=inbox`, select Catania and open `DEMO/OUT/0003` or `DEMO/OUT/0015`: both reference Museo Vincenzo Bellini at `37.5025956, 15.0843868` while remaining separate Picking records. The map groups their shared point; nearby distance remains straight-line distance, not driving time.

## Applied and verified — 2026-11-09

The existing Docker stand was backed up to `.local/backups/docker_20261109T162551Z_ac4124c0` with writers stopped. Updated 11 source streets, imported all 20 tracked Picking successfully, and populated 19 destination references. Customer 12 remains without a street. Repetition updated zero source streets and zero destination references, with identical delivery data and versions.

Preservation comparisons in `.local/public-addresses-20261109` confirm unchanged operational delivery fields, all other source/business tables and pre-existing audit rows. Existing visits, customer confirmations, staffing, transport, completed results, signatures and files were retained. Backend, importer and database restarted successfully.

Full backend typecheck, typed lint, backend/tools builds, two focused PostgreSQL tests and the existing frontend `test/section-two.smoke.ts` passed. Authenticated live API comparison checked every one of the 14 Inbox markers against the manifest's exact street, coordinates, province and CAP; one incomplete destination remains separate. No frontend code was changed or rebuilt for this data-only update.

Browser checks confirmed updated table addresses/CAP, Catania automatically selecting CT, CAP 95124 narrowing to two separate Picking at the shared museum point, marker-to-detail navigation, and the new address in Nearby work. At a 1 km radius around customer 3, customer 9 is about 0.4 km away and customer 5 about 0.5 km away; customer 7 at about 1.5 km is excluded. The map visibly places the marker on Palazzo Gravina Cruyllas, which houses the museum. Browser evidence: `.local/public-addresses-20261109/public-address-map.png` and `nearby-public-addresses.png`.
