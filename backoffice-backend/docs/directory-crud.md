# Participants, crews and task templates CRUD

The authenticated Backoffice API supports list, single-record read, create, update and delete for `/participants`, `/crews` and `/templates`. Existing payloads are unchanged. Individual `GET /{directory}/{id}` returns the list's public record shape, never passwords or hashes.

Create, update and delete are available to authenticated admin and operator users, including Francesca. Participant skill grants are also editable by both roles. Crew sessions cannot access these Backoffice endpoints. Mutations require the exact configured Backoffice Origin and JSON content type. CORS permits DELETE; all three directory prefixes use `Cache-Control: private, no-store`.

Participant CRUD includes managing the participant's Crew login and setting a replacement password. Passwords are write-only; reads expose only `login` and `hasPassword`. Omitting `password` preserves the stored hash; omitting `skillIds` preserves qualifications. Profile updates require the existing complete profile fields so missing inputs cannot silently clear login or contact details. Unknown `role`, `password_hash` or similar fields are rejected. These operations update `person`, never Backoffice `app_user` accounts or roles. The participant-calendar public profile remains separate and still omits login, password state and skills.

## Deletion and history

`DELETE /participants/{id}`, `/crews/{id}` or `/templates/{id}` accepts only `{ "version": <current positive integer> }`. HTTP 200 returns `{ "id": "<uuid>", "deleted": true }`.

- Only unused records can be deleted. Exact UUID references anywhere in delivery aggregates, route drafts, published routes or route revisions prevent deletion, including cancelled visits, superseded reports, and drivers in immutable transport snapshots. Resource reservations and participant calendar history are checked too. Matching is case-insensitive and parameterized, not substring matching.
- The guard checks all persisted JSON reference values without the list endpoint's 5000-record bound. This conservative local-demo check does not replace relational foreign keys in a future normalized model.
- A participant must leave their default crew first. Deleting an unused crew removes only its roster links and preserves people. Deleting an unused participant removes skill links; the existing foreign key cascades deletion to crew sessions.
- References return 409 with an instruction to disable instead. Disable/enable remains a reversible update and never rewrites snapshots. Stale versions return 409; missing/deleted records return 404.
- The existing scheduling/catalogue advisory transaction lock serializes delete against assignments, staffing, routes and updates. Audit stores ID/version only, with no credentials or contacts.

No migrations, schema resets, dependencies or infrastructure were added.

## Operator permissions — 13 November 2026

The explicit user request extended Francesca/operator from Skills/Vehicles to Participants, participant skill grants, Crews and Task templates. Only these existing catalogue checks changed; the shared Backoffice/Crew authentication guard and account roles are unchanged. No additional Backoffice user-management endpoint was introduced.

Backend typecheck, typed lint, production build and OpenAPI generation passed. The targeted Docker/PostgreSQL run passed **41/41**, including operator create/update/delete, Crew credential changes, omitted-password preservation, exact unchanged `app_user` identity/role/password rows, rejected role/hash mass assignment, anonymous/Crew denial, Origin/version conflicts, roster constraints, protected snapshots and concurrent scheduling. Each PostgreSQL suite used its own unique schema in verified `delivery_backoffice_test`, then cleaned only its owned schema; application and Odoo records were untouched.

```powershell
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" tools npx tsx --test --test-concurrency=1 test/catalogue-crud.test.ts test/participants.test.ts test/skills.test.ts test/transport.test.ts test/route-lifecycle-openapi.test.ts
```

## Verification — 10 November 2026

Full `npm run typecheck` and `npm run lint` passed. Docker tools build compiled the backend. The isolated PostgreSQL command passed **15/15** tests:

```powershell
docker compose --profile tools build tools
docker compose --profile tools run --rm --no-deps tools npx --no-install tsx --test --test-concurrency=1 test/participants.test.ts
```

The suite creates uniquely named schemas in verified `delivery_backoffice_test`, applies existing migrations there and cleans only those schemas. Coverage includes admin/operator/anonymous/crew access, strict bodies/UUIDs, CORS/Origin, versions, single reads, list removal, roster protection, crew member preservation, skill/session cleanup, credential-free audit, unchanged current/cancelled/superseded history, retired drivers, route references and concurrent delete versus update/assignment. Existing participant/staffing regressions also passed. Main database records were not mutated by these checks.

Run `npm run openapi` to regenerate the API description. The main runtime was rebuilt with `docker compose build backend` and restarted with `docker compose up -d --no-deps backend`; backend and database are healthy. Live authenticated GET-by-ID, no-store headers, anonymous access denial, operator DELETE denial and DELETE preflight passed for all three directories. Before/after digests confirmed the main deliveries, participants, crews, roster links, templates and route drafts were unchanged. Browser verification is recorded in the frontend `docs/directory-crud.md`.
