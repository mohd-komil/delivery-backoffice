# Route departure, work and return

Section 3 extends the existing route draft rather than booking or publishing a trip. The backend owns the time calculation. A route visits each selected Picking in order and travels from the last stop directly to its selected return point; it does not return to the depot between jobs.

## Inputs and estimates

- Departure is an instant entered/displayed in `Europe/Rome`. Start and return points can differ. Catania and Messina teaching reference points use the public venues from `local/public-demo-addresses.json`; they are not company warehouses. The older Milano/Monza examples remain available for saved drafts.
- Each stop has editable on-site minutes, including work still required after a partial delivery. The suggested value comes from the shared remaining-work estimate. An unavailable suggestion uses the existing 30-minute provisional fallback, visibly requiring review.
- `useLocalEstimates` enables a teaching travel approximation: `ceil(straightLineKm × 1.3 / 30 × 60)` minutes. The response source is `local_demo`. These arbitrary demo assumptions are **not road routing**, traffic, vehicle access, ferry timing or calibrated operational estimates. Identical coordinates give zero travel but retain each Picking's own work duration. Missing coordinates or unsupported values remain unknown.
- Manual minutes take priority for a particular directed pair. A→B and B→A are separate values. Reordering preserves entered alternatives; changing the return point uses the corresponding last leg. Removing an override reveals the applicable estimate again.
- New manual estimates bind to the current address and resolved coordinate context. A changed address, pin or confirmed entrance invalidates the old estimate and yields a warning. Legacy unbound estimates remain readable with an explicit review warning. Reopening/refreshing does not silently rebind them.
- Google road calculation and the Google map require explicit opt-in. The local workflow does not request Google APIs even when keys are configured.

`useLocalEstimates` is persisted with the versioned draft. Legacy JSON without this property defaults to false and retains its existing explicit demo/manual behavior. New Routes/Inbox drafts can use the local teaching mode. This change needs no database migration.

## Timeline

The response shows departure and start point, departure for each consecutive leg, travel duration and source, ETA, the on-site duration, work start/end, any wait, last work completion (`returnDepartAt`) and the final return leg/time. Totals separate travel, work and waiting:

`total = travel + work + waiting`

If a leg is unknown, dependent arrival/finish/return times remain unknown; known work duration remains available. A single confirmed booked appointment on the departure's Rome calendar day supplies the existing start/end constraints. Waiting before its start is included. `late` means **work finishes after the appointment end**, not simply late arrival. Multiple matching confirmed appointments are explicitly ambiguous and none is silently chosen.

Current boundary: automatic appointment matching is limited to the departure day in Rome. Overnight date arithmetic is supported, but a following-day appointment window is not automatically selected. Shift limits, resource conflicts over the entire trip, selectable appointment windows, depot management and route publication remain subsequent work. Saving a draft does not reserve crews, vehicles or visits and does not authorize Crew execution.

The symmetric local approximation can produce the same total when two stops with the same start/return point are reversed. Individual legs and ETAs still recalculate. Directed manual estimates demonstrate a different total without inventing asymmetric road data.

## Acceptance on the new public Catania addresses

The explicitly entered teaching minutes below are independent of the coordinate approximation. Departure is 10 November 2026, 09:00 Rome (UTC+01:00).

- A: `DEMO/OUT/0003`, Piazza San Francesco d'Assisi 3 — 40 minutes of work.
- B: `DEMO/OUT/0009`, Piazza Federico II di Svevia — 35 minutes of work.
- Catania reference→A: 30; A→B: 20; B→reference: 25 minutes.
- Catania reference→B: 42; B→A: 28; A→reference: 22 minutes.

| Change | First ETA | Last work completion | Return | Total |
| --- | --- | --- | --- | --- |
| A then B | 09:30 | 11:05 | 11:30 | 150 min |
| B then A | 09:42 | 11:25 | 11:47 | 167 min |
| B then A, B work +10 min | 09:42 | 11:35 | 11:57 | 177 min |
| A then B, departure 10:00 | 10:30 | 12:05 | 12:30 | 150 min |

Checks use the existing project typecheck, typed lint and builds. Pure tests cover arithmetic, direction, missing values, zero travel, waits and midnight/DST instants. Integration tests use dedicated real PostgreSQL schemas with normal auth/Origin guards, save/reopen, concurrency and a Google provider that fails if unexpectedly called. `backoffice-frontend/test/route-time.smoke.ts` repeats the table above through the running authenticated local API using previews only; it preserves saved drafts and deliveries.

```powershell
# backend
npm run typecheck
npm run lint
npm run build
docker compose --profile tools build tools
docker compose --profile tools run --rm tests npx tsx --test --test-concurrency=1 test/route-calculation.test.ts test/route-nearby.test.ts

# frontend, after the compatible backend is deployed
npm run typecheck
npm run lint
npm test
npm run build
npx --no-install tsx --test test/route-time.smoke.ts
```

## Verified local runtime — 9 November 2026

Backend typecheck, typed lint, build and 21 routing/Google-provider regression tests passed on isolated PostgreSQL. Frontend typecheck, full typed lint, 132 tests and production build passed. The live authenticated route-time and Section 2 smoke tests both passed against the rebuilt Docker API. OpenAPI was regenerated. Deployment required no migration or seed; delivery rows, unloading entrances and existing route drafts matched their before/after snapshots.

Browser acceptance used the two public Catania addresses above. The coordinate approximation gave 11 minutes travel, 75 minutes work and return at 10:26. Explicit directional manual estimates produced the first three rows of the acceptance table: return 11:30, then 11:47 after reversing the stops, then 11:57 after adding ten minutes work. Refresh retained input, order and the expanded manual section. A new draft named `DEMO Catania · Route timing` was saved and reopened with departure 09:00, B then A, work 45/40 minutes, total 177 minutes and return 11:57. No crew or vehicle was assigned; existing delivery/visit records were not modified.

Light/dark desktop and 320 px layout checks passed without document horizontal overflow; console warnings/errors were empty and no Google Maps script was loaded. Temporary appearance/viewport changes were restored. The backend runs in Docker on port 3001 and the native Next production frontend runs on port 3000. Browser evidence is in the frontend's `docs/screenshots/routes-timing-20261109.png` and `routes-timing-mobile-20261109.png`.
