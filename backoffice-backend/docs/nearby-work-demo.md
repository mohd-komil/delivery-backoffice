# Nearby work demo coordinates

**Current stand, 2026-11-09:** all `Via Dimostrativa` addresses are replaced by [public venue reference addresses](public-demo-addresses.md). The original fixtures and distance examples below remain useful for isolated tests; they no longer describe the updated running stand.

The existing `odoo_mock` deliveries use fictional `Via Dimostrativa` addresses. Their optional `routePoint` is a synthetic reference point for radius search. It is not an address geocoded by Google or a confirmed unloading entrance. No Google API is called by this population script or by the nearby-distance calculation.

## Repeatable population on the local Docker stand

Run from `backoffice-backend` after rebuilding the tools image with the new script:

```powershell
docker compose --profile tools build tools
docker compose --profile tools run --rm tools npx tsx scripts/demo-coordinates.ts --apply
```

The command authenticates the existing demo operator from `.local/demo-accounts.json`, does not print credentials, and signs out after completing. It only runs in a non-production tools process against the named local application databases on PostgreSQL port 55432. The runtime backend can remain in production mode.

Only imported fixtures with `source_instance=odoo_mock`, source IDs 1–20 and their exact original fictional customer/address/city/country are eligible. Existing reference points, confirmed entrances and changed addresses are preserved. The missing street on `DEMO/OUT/0012` remains missing so that the incomplete-address scenario can still be checked. Repeating the command adds no further changes.

Each eligible row gains only `routePoint`, a matching version increment and a `demo.coordinates_added` audit event. The source snapshot, schedules, assignments, quantities, service plans, signatures, files and previous history remain unchanged. Fake Odoo is not written to. The normal importer preserves the reference point while the customer/address remains unchanged and clears it when the destination changes.

## Radius checks

Select `DEMO/OUT/0009` in Inbox to plan as the anchor. It uses Catania reference point `37.5079, 15.0830`. Provided the relevant work remains open, these independently specified approximate distances apply:

| Candidate | City | Straight-line distance | First example radius that includes it |
| --- | --- | ---: | ---: |
| `DEMO/OUT/0015` (same address as `0003`) | Catania | 0.76 km | 1 km |
| `DEMO/OUT/0017` (same address as `0005`) | Catania | 4.76 km | 5 km |
| `DEMO/OUT/0002` | Catania | 7.38 km | 10 km |
| `DEMO/OUT/0019` | Catania | 11.77 km | 20 km |
| `DEMO/OUT/0014` | Messina | 86.76 km | Outside the supported 50 km maximum |

Completed deliveries and work without remaining operations are excluded by the ordinary routing rules. Existing business status may also exclude a candidate, so the table defines distance expectations rather than forcing a completed job back into planning. Shared addresses intentionally have identical coordinates and remain separate Picking jobs.

`node --import tsx --test test/demo-coordinates.test.ts` verifies real PostgreSQL writes in its own schema in `delivery_backoffice_test`, including concurrent repeated runs, existing coordinates, confirmed entrances, changed-address and source isolation, exact preservation of all other delivery fields and the production-mode guard.
