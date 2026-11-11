# Atomic route publication — task 06

11 November 2026. [Product contract, task 05](route-publication.md) · [Notion task 06](https://app.notion.com/p/4154433fac0f811a802cc797ceecc839).

## Scope and rollout

The backend implements publication review and atomic Publish. Backoffice has a separate review form below the saved route draft. Publication reserves exact work through visits and the complete trip through one route-owned resource ledger. It does not confirm customers, start trips, submit Crew reports or close deliveries.

`ROUTE_PUBLICATION_ENABLED=false` is the default. Read-only review is available; the server also rejects Publish while disabled. Keep the shared demo disabled until tasks 07–09 provide departure, cancellation and actual-return controls. The isolated browser demonstration enables publication only against a fresh, owned schema in `delivery_backoffice_test`.

Existing standalone visits remain operational. A published route's visits cannot start before departure; task 07 will provide the route action and queue. There is deliberately no operator override that bypasses customer confirmation or assignment authorization.

## API

All endpoints use existing Backoffice authentication and mutation Origin checks. Crew credentials cannot call them.

| Endpoint | Meaning |
| --- | --- |
| `GET /api/routes/publication-capability` | `{ enabled, reason }`; the default gate is closed. |
| `POST /api/routes/:id/publication-review` | Saved `version`, ordered exact `stops`, optional `externalDriverPhone`. Returns timeline, feasibility, exact visits/work/tasks/responsibility, confirmation state and review fingerprint without writing. |
| `POST /api/routes/:id/publish` | Same selection plus `requestId`, `fingerprint`, `acknowledgeEstimates`. HTTP 200 on success/replay. All participating records commit or roll back together. |
| `GET /api/routes/:id/publication` | Publication summary and immutable publication-time `review`, or null. Its confirmation statuses describe the saved moment, not later live confirmations. |

Each selection is explicitly `create` or `attach`:

- `create`: `deliveryId`, `responsibleParticipantId`, `workLines`, `templateIds`, optional `returnRequestId`. Work lines use source-line IDs and integer milli-quantities for delivery/installation/collection. They are not recomputed as all remaining work on click.
- `attach`: `deliveryId`, exact `appointmentId`, `responsibleParticipantId`. This must match the saved draft's chosen appointment. Its scope, assignment, responsible participant and interval must already be compatible. No silent reschedule or confirmation reset occurs during attachment.

The form invalidates review after editing or refreshing dependencies, retains entered values, and requires a new review before Publish. A retry after an uncertain response uses the same request ID and command. A published draft becomes read-only; the API rejects a draft PATCH as well. Existing general service/task/stock rules remain authoritative.

Generated OpenAPI is in [openapi.json](openapi.json). Review/publication input schemas reject unknown fields. Safe domain errors identify stale draft/review, ownership, quantity, readiness, resource, window or acknowledgement problems; raw SQL/stack traces stay private.

## Storage and consistency

Migration `RoutePublication1793701100000` only adds:

- `route_publication`: route/draft version, current lifecycle status, immutable reviewed snapshot, publisher/time and unique request receipt/fingerprint.
- `route_stop`: exact appointment/delivery membership, order, created/attached provenance and original appointment/resource snapshots. A partial unique index permits at most one active route per appointment.
- `route_reservation`: one raw departure-to-return interval and explicit buffer per route/resource. Existing child ledgers are retained, while the normalized resource query recognizes their route owner.

The existing scheduling lock coordinates publication with individual booking/assignment/transport and source refresh. Selected delivery rows are also locked in stable ID order before the publication read: evidence finalization uses row locks without the scheduling lock, so this prevents overwriting a concurrent photo linkage or delivery version. Every operation uses the same transaction manager. Existing `planVisitWork`, skill qualification, task instantiation and shared assignment snapshot construction are reused. Publication never calls the HTTP API recursively or commits each stop separately.

The reviewed fingerprint includes draft/version, exact selection, source/work, task templates, actual resources, schedule and point contexts. Speculative visit/task IDs are deterministic. Only the generated timestamp of a new scope is excluded from comparison; an attached scope's actual timestamp remains part of its snapshot. New persisted scope confirmation uses the real publication preparation time, not the older draft-save time.

Resource queries for standalone staffing, vehicle/driver availability and route preview share the route-aware ledger. They use raw intervals and the larger applicable transfer buffer once. An exact route child may share its parent's reservation; unrelated visits never inherit that exemption. The participant calendar separately shows full-trip reservations without pretending travel is on-site appointment time.

Standalone edits of linked time, scope, assignments, responsibility and transport are blocked. Disabling a used person/crew/vehicle or removing a required skill is also blocked pending the route workflow. Default crew-roster changes do not rewrite actual staffing. A completed stop cannot erase the route reservation. Start checks distinguish planned return from an outstanding actual return; the actual return action itself belongs to task 09.

## Database verification and recovery

The migration validates the database name and isolated server port, requires a transaction and performs no seed/reset or historical rewrite. Its `down()` intentionally refuses destructive automatic removal of published history. Plan a reviewed restore/recovery if reversal is needed.

Tests create unique owned PostgreSQL schemas and use real application guards. The older general integration suite uses the separate test database's public schema, so apply the additive migration there before running it:

```powershell
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/scripts:/app/scripts:ro" tests npm run migrate -- --test
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" -v "${PWD}/scripts:/app/scripts:ro" tests npm test
npm run typecheck
npm run lint
npm run build
npm run openapi
```

The first broad run exposed the missing new migration on that pre-existing test schema. After applying only `RoutePublication1793701100000`, **243/243 backend tests passed**, with no failures or skips. The full run is recorded in ignored `.local/route-publication-full-tests.log`. The publication suite covers real authorization/default gate, separate same-SKU lines, explicit second-of-two attachment, replay, late database failure and complete rollback, conflicting publications, stale inputs, return-only resource conflicts, protected linked mutations, skill/resource changes and buffer arithmetic. Injected failure log messages are intentional negative tests.

After the final corrections, the focused publication suite passed **13/13 tests**. Its concurrent row-only writer regression commits an issue photo linkage while publication waits: the stale publication is rejected without partial writes, and a new review/retry preserves the photo. The suite also checks uppercase participant IDs against the resource protections. Browser acceptance exposed a null-response serialization problem; the controller now sends an explicit JSON `null` for an unpublished draft, with a real HTTP-body regression and published-review readback check. Backend typecheck, typed lint, build and OpenAPI generation passed; the broad run preceded these final focused corrections.

This is local verification, not customer acceptance. The main `delivery_backoffice` database and its user demo fixtures have not been migrated, reseeded or published by the task-06 browser harness.

### Chrome acceptance, 11 November 2026

The authenticated isolated Backoffice published both demo routes through the interface: two new visits, and one explicitly attached confirmed visit plus a new stop. Refresh preserved exact quantities, tasks and responsible selections; it invalidated the old review/acknowledgement. Re-review and Publish succeeded. The readback is an immutable version 1 and labels customer confirmations as publication-time snapshots. The participant calendar visibly separates the whole-trip reservation from on-site visits. Same-SKU lines from distinct orders retained separate quantities.

Independent read-only PostgreSQL verification in owned schema `route_publication_demo_4534ded9e60341caa058687204c6003d` found:

- Routes `e7b5fc5a-12fa-42d0-be67-ba89ffc72961` and `d0301c44-912b-4638-8214-4b426ff1eb22`: both published version 1, two stops each, four appointments total, no duplicate visit.
- Attached appointment `6672050a-a13b-493f-81e0-0cdd882f6f36` keeps all prior JSON fields, including work, assignments and customer confirmation. The only added field is the intended route transport allocation; its original snapshot remains in provenance.
- Each route owns exactly three resources (crew, person/driver and vehicle), raw interval 13 November 08:00–09:08 UTC with a separately stored ten-minute buffer. Travel remains an estimate, not road-provider data.

See the frontend's `docs/route-publication.md` for its checks and isolated launch instructions. These tests do not exercise physical phones, route departure/cancellation/actual return, customer acceptance or real Odoo.

## Isolated browser demonstration

`scripts/demo-route-publication.ts` runs the real Nest application and authorization against a new `route_publication_demo_<uuid>` schema in `delivery_backoffice_test`. It verifies the target, applies real migrations and creates two fresh drafts: all-new visits, and an explicitly attached confirmed visit plus a new one. Each includes distinct orders with the same SKU. It does not submit Publish on the user's behalf during setup.

It uses port 3011 for the API and expects the separate frontend at `http://127.0.0.1:3010`. The extra frontend origin is allowed only with `BACKOFFICE_TEST=1`. Credentials and draft IDs are saved to ignored `.local/publication-browser-demo/connection.json`; never copy its contents into Notion or committed documentation. Private files use an owned directory. Stopping the server leaves its owned schema/files for inspection; rerunning creates a fresh namespace and preserves earlier demonstrations.

The shared Backoffice/Crew ports 3000/3002 and backend 3001 are separate. Publication is not enabled there by this harness.

From `backoffice-backend`, with the existing test-tools image and healthy local database:

```powershell
New-Item -ItemType Directory -Force -Path .local/publication-browser-demo | Out-Null
docker compose --profile tools run --rm --no-deps --name delivery-publication-browser --publish 127.0.0.1:3011:3001 -e BACKOFFICE_TEST=1 -e ROUTE_PUBLICATION_ENABLED=true -e FRONTEND_ORIGIN=http://127.0.0.1:3010 -v "${PWD}/src:/app/src:ro" -v "${PWD}/scripts:/app/scripts:ro" -v "${PWD}/local:/app/local:ro" -v "${PWD}/.local/publication-browser-demo:/app/.local/publication-browser-demo" tests npx --no-install tsx scripts/demo-route-publication.ts
```

Do not start a second instance with the same container name/port. For this task-owned instance only, `docker stop --timeout 10 delivery-publication-browser` stops the API; its test schema and files remain. Restarting this harness generates new credentials/draft IDs, so reread its ignored manifest. It is not a command to restart the shared backend.
