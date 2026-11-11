# Vehicles and transport for a picking visit

One Delivery represents one picking, which can contain lines from several sales orders. Its visits can use different crews and vehicles. Commercial orders stay read-only; see [source-model.md](source-model.md).

## Catalogue and workflow

`Vehicles` appears directly below `Skills`. Administrators create/edit vehicles; operators can view the catalogue and assign transport to visits. A physical vehicle has a name, unique plate, company/external ownership, operational status, enabled flag and notes. External vehicles identify their provider and contact. Ownership is independent of the crew and driver.

1. Book an appointment and assign the actual crew/participants/tasks.
2. In that visit's **Transport** section, add a vehicle. The reservation defaults to the visit interval and can extend for loading, travel and return.
3. Optionally select a participant as driver or record an external driver. Driver identity is independent of crew membership; no licence or driving qualification is inferred from participation.
4. Add another vehicle if needed. Several crews of the same visit share its transport list, avoiding duplicate physical bookings.
5. Replace a vehicle with a reason for a breakdown/change; the old allocation remains in history. Cancel a transport allocation with a reason to release its booking.

Only booked visits can change transport. Started/completed/cancelled visits retain their recorded allocations. A follow-up visit has its own independently chosen transport and can use a different crew. Cancelling a booked visit retires its active allocations with the visit cancellation reason.

For the first version, a visit with active transport must have transport cancelled before it is rescheduled, then explicitly reallocated. This prevents accidentally retaining the old reservation window. The interface explains this rule; it does not silently move a car.

## Availability and history

Every active vehicle reservation must cover the whole visit, with a positive interval no longer than 45 days. Half-open intervals permit a following reservation exactly at the previous end. The API rechecks conflicts in the same PostgreSQL scheduling transaction as the delivery version and idempotency receipt; UI availability is advisory.

Registered participant drivers and staffing share the same person resource. A driver who also belongs to that visit's crew is not double-booked against themselves. Another visit cannot use that participant during the transport reservation, including its loading/return extension. Editing visit staffing preserves transport bookings. **Completing work at the customer does not release the vehicle or registered driver before the reserved return time.** Replacement/cancellation explicitly releases the retired allocation. An external driver's name/phone are recorded contact details, not a verified global participant identity; their availability requires manual confirmation.

Allocation snapshots retain vehicle/provider/driver details at booking. Catalogue edits do not rename historical allocations; execution results capture the transport used. Old results without transport snapshots remain unchanged. Disabling a vehicle or marking it for maintenance prevents new allocations; it does not silently cancel existing bookings.

The application stores catalogue vehicles in `vehicle` and active derived bookings in `transport_reservation`, alongside the existing crew/person reservation ledger and delivery aggregate history. `VehicleTransport1793700400000` adds these tables without rewriting old deliveries, appointments, results or source records. Automatic destructive rollback is not provided; use the current Docker backup procedure in [recovery.md](recovery.md).

## API

All routes are under `/api`, use existing session guards and validate writable fields. Browser writes require the exact configured Origin.

- `GET/POST /vehicles`; `PATCH /vehicles/:id` with captured `version` (writes: admin).
- `GET /deliveries/:id/appointments/:appointmentId/transport/availability?from=...&to=...` (admin/operator).
- `POST /deliveries/:id/appointments/:appointmentId/transport` adds `{version,requestId,vehicleId,reserveFrom,reserveTo,driver}`.
- `POST .../transport/:allocationId/replace` adds the replacement fields plus `reason`.
- `POST .../transport/:allocationId/cancel` takes `{version,requestId,reason}`.

Transport commands return the updated delivery detail. A retry with the same request ID/payload returns the recorded receipt before reconsidering current catalogue availability; changing a used request's payload conflicts. The generated [OpenAPI contract](openapi.json) specifies exact schemas and bounds.

## Fictional examples

After Docker startup, run from `backoffice-backend`:

```powershell
./scripts/demo-vehicles.ps1
```

This authenticates through the local API and creates only missing deterministic plates: two available company vehicles, one company vehicle in maintenance, and one available external vehicle. Repetition preserves existing catalogue edits and all appointments. Names, plates, provider and contact are fictional; these are persisted records, not static frontend mocks. A private run report is saved under ignored `.local/vehicle-demo-runs` without credentials.

## Scope

The prototype requires a known physical car. It does not claim availability from a provider's name alone, send provider messages or make commercial bookings. There is no route optimisation, automatic load/capacity check, vehicle telematics, licence/insurance verification, frontoffice or production deployment. Product weights/dimensions and transit times are unknown; reserving a slot does not prove load or route feasibility.

Cancellation release was rechecked on 2026-11-04: both crew/person and vehicle/Participant-driver ledgers become empty for the cancelled visit, while snapshots and reasons remain. The same resources were successfully rebooked for an exactly overlapping visit through real guarded HTTP on isolated PostgreSQL (targeted suites 20/20 PASS). A one-time, locked cleanup removed 27 legacy service-ledger rows that the effective availability queries already ignored; all nine live cancelled visits now have zero ledger rows. The recovery inventory and preservation evidence are recorded in STATUS.md. No operational history or default crew membership was erased.
