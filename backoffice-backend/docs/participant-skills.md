# Participant skills

The 2026-11-04 requirement assigns skills to **Participants**. Participants retain their skills when they move between crews. Every participant assigned to a task must have every skill required for that task.

## Backoffice workflow

The **Skills** section is under **Delivery views**. The **Skills** tab shows the live catalogue with each skill's name, description, and enabled status. In **Participant skills**, select a person and save their skill set in one action. The same skills are available in the **Participant** form. Administrators and operators can create, edit, enable, or disable skills, delete unused entries, and assign skills to participants.

Set required skills in **Task templates**. Assigning a visit or changing its roster in **Visit staffing** checks all selected participants, including people whose default crew is different. The interface explains why participants who lack a required skill are unavailable for selection. Remove a conflicting selection to enable saving. The backend verifies the requirements independently.

Existing profiles and templates can retain or remove a disabled skill. New skill assignments require an enabled skill. Disabled skills do not satisfy requirements for a new assignment or a staffing change to a planned visit. To proceed with a new assignment, an administrator must correct the skills or requirements, or enable the skill again.

## Data and history

- `skill` is a separate catalogue with a UUID, version, name, description, and status. The trimmed name must contain 1–200 characters. The optional description has a limit of 2,000 characters. An index on `lower(name)` prevents duplicates.
- `participant_skill` links `person.id` to `skill.id`. A composite primary key prevents duplicates and foreign keys protect references.
- `task_template.data.requiredSkillIds` stores the template's requirements. A missing field in older records represents an empty set. A PATCH that omits the field preserves its value. Sending `[]` clears it explicitly.
- New task snapshots store all validated requirements in `requiredSkillsSnapshot`. New person snapshots store only the participant's enabled skills in `skillsSnapshot`, using their UUIDs and names at the time of capture. Later renames and profile changes do not rewrite these snapshots.

Older delivery JSON and signed results keep their original fields. Staffing changes use the requirements of the saved visit task. Starting, executing, or rescheduling an assigned visit does not recheck the existing roster's skills. Participants can still belong to only one default crew.

Updates to skills, participants, task templates, and planning share the existing transactional advisory lock. Stale versions return 409. Replaying a recorded command with the original payload returns its saved result, even after catalogue changes. Disabling a skill preserves its records, assignments, requirements, and snapshots. As of 2026-11-13, an administrator or operator can delete only an unused skill. A current participant assignment, a template requirement (including a disabled template), a delivery, a saved route, or a historical route revision blocks deletion with 409. Review an active published route before disabling one of its required skills.

## HTTP API

All endpoints require an active Backoffice session, and writes require the exact configured Origin. Administrators and operators can manage the skill catalogue, participant assignments, and task templates.

- `GET /api/skills`, `GET /api/skills/:id`, `POST /api/skills`, `PATCH /api/skills/:id`.
- `DELETE /api/skills/:id` (admin/operator) accepts exactly `{ version }` and returns `{ id, deleted: true }`. A stale version or existing reference returns 409. An unknown or already deleted UUID returns 404. The audit log retains `skill.deleted`. The endpoint follows the existing deletion behavior for participants, crews, and task templates and preserves associations.
- `PATCH /api/participants/:id/skills` accepts `{ version, skillIds }`, updates only the participant's skills, and increments their version.
- The existing participant POST/PATCH endpoints accept optional `skillIds`. Contact information, login, and password follow the existing rules. The skills-only endpoint leaves those fields intact.
- The participant GET endpoint and visit availability return `skillIds`. The public participant calendar profile omits this field.
- Templates return `requiredSkillIds` as an array, with `[]` for older records. Template PATCH accepts an optional read-only `id` for existing clients. The API validates it against the UUID in the URL, ignoring case. The URL always identifies the record. Unknown fields are rejected.

## Migration and verification

`ParticipantSkills1793700300000` adds the catalogue, associations, constraints, and indexes. Existing rows and JSON are preserved. Before migrating the running Docker environment, take a fresh, consistent Docker backup.

```powershell
docker compose --profile importer stop backend importer
./scripts/docker-backup.ps1 -WritersStopped
docker compose run --rm --no-deps tools npm run migrate
docker compose --profile importer up -d --wait
```

Check each operation before moving to the next command. `docker-backup.ps1` verifies the exact Compose project and volume, confirms writers have stopped and no database clients are active, and copies three databases, globals, all app-data, and private recovery secrets. It writes the manifest only after verifying rows, sequences, and the exact contents of the archived files. Git ignores the secrets and archives. The script keeps secrets and archives out of its output. Restore and volume removal are manual operations.

## Migration and verification results

Writers were stopped before the main migration, and a fresh Docker backup was created at `.local/backups/docker_20261104T125802Z_10dabf0b/docker-backup-manifest.json`. `ParticipantSkills1793700300000` was applied to the main and test databases, bringing each to four migrations. Before restart, `skill` and `participant_skill` were empty and the migrations table sequence had advanced by exactly one entry. The `independent-skills-migration-verification.json` report beside the manifest verified existing rows and history, the schemas of existing tables, the application, test, and source databases, app-data, and seven secret files. These results describe the baseline before the demo API operations below. The preserved native cluster is stopped.

Checks of the Docker backup helper, its guards, and the resulting backup passed for the complete app-data tar archive and source data. Restore is manual, and a fresh restore of this archive was not performed. Recovery secrets, credential manifests, dumps, and private files are kept outside Git. Their contents were not printed.

Docker passed **95/95 backend tests**, typecheck, full typed lint, and the runtime and tools builds. The full suite covers real guards, isolated PostgreSQL, all skill requirements for each participant, staffing overrides, saved task requirements, disabled and retained skills, immutable snapshots, receipt replay, concurrent transactions, and preservation of old JSON during migration. The frontend passed typecheck, typed lint, **62/62 tests**, the build, and the live read-only HTTP smoke test (**1/1 PASS**).

Backend test files run sequentially (`--test-concurrency=1`) because isolated schemas in a single test database share the PostgreSQL advisory locks used by the importer and planning. Individual tests still cover concurrent transactions. This avoids unintended lock contention between test files while preserving production locks and authorization rules.

The runtime and database were healthy. The active importer read 20 eligible source pickings every 60 seconds. The API listens at 127.0.0.1:3001, PostgreSQL on port 55433, and the host frontend on port 3000. The checks used the local demo environment. Customer qualifications and production deployment were outside the verification scope.

## Fictional catalogue and repeatable example

```powershell
./scripts/demo-skills.ps1
./scripts/demo-skills.ps1 -AssignSimoneExample
```

The regular run uses a real admin HTTP session to create missing catalogue entries for Product inspection, Quantity verification, Integrity inspection, Furniture assembly, Site cleanup, and Packaging removal. Existing entries retain their values and enabled status. `-AssignSimoneExample` assigns enabled skills only to `394f4f47-b646-477c-8794-192a26d90c83` (Simone) and adds Furniture assembly to the requirements of `30000000-0000-4000-8000-000000000004` (Assemble). The script refuses to substitute another record if a specified UUID is missing or the template assignment has changed.

For the separate Odoo customer-development environment (`http://127.0.0.1:3031`), run `./scripts/demo-skills.ps1 -CustomerDevelopment`. The script verifies the target URL and `sourceModel`, uses an existing admin session, and adds only missing demo skills. This set adds Wall fixing and Fragile furniture handling, for eight skills in total. Participant assignments, existing records, visits, and Odoo data are preserved. This option cannot be combined with `-AssignSimoneExample`. On 2026-11-13, the first run created eight fictional skill entries and the second created zero. The entries demonstrate the catalogue and do not verify anyone's qualifications.

The first verified run created six skills and made two metadata updates. The second created and updated zero records. Existing visits, snapshots, default rosters, contact details, logins, and passwords were preserved. Non-sensitive run reports are stored in the ignored `.local/skill-demo-runs` directory. The regular seed leaves these demo qualifications unassigned.

The browser check added a seventh entry, Heavy lifting, and assigned Heavy lifting and Product inspection to Antonio Lombardo (`20000000-0000-4000-8000-000000000005`). Two badges confirmed the assignments. Refresh in **Skills** under **Delivery views** preserved the **Participant skills** tab, the Antonio search, and the **Enabled** filter. These records are demo assignments.

## CRUD verification 2026-11-13

**Current policy after the follow-up request.** Administrators and operators can also manage participants, crews, task templates, and participant skill assignments. The participant profile manages only Crew login credentials. The latest targeted suite passed 41/41 HTTP/PostgreSQL checks, plus typecheck, typed lint, the build, and OpenAPI generation. See [directory-crud.md](directory-crud.md#operator-permissions--13-november-2026) for password preservation, profile fields, and account boundaries.

At the first permissions checkpoint, Francesca (`operator`) could manage the Skills and Vehicles catalogues alongside administrators. Under that historical policy, only administrators could manage participant skill assignments, crews, participants, and task templates. The checkpoint preserved global roles, sessions, and Origin checks. Tests with a real operator session verified creation, reading, editing, disabling, and deletion of unused entries. They also verified 409 responses for entries in use and resources on an active route. Crew and anonymous requests were denied. The targeted suite passed 40/40 isolated PostgreSQL checks, and the build and OpenAPI generation passed.

Single-record GET and guarded DELETE endpoints were added for Skills and Vehicles without a migration. `npm run typecheck`, `npm run lint`, and `npm run build` passed. The new `test/catalogue-crud.test.ts` suite passed 7/7 checks. The Participants, Skills, Transport, and OpenAPI regression suites passed 32/32. Tests used real sessions and authorization guards, an unexpected Origin, admin/operator/Crew roles, strict input validation, stale versions, people/template/route references, snapshot preservation, and races between deletion and skill assignment or vehicle updates and allocation.

PostgreSQL tests ran through Docker tools against `delivery_backoffice_test`. Each scenario created and removed only its own unique schema. The native host instance at `127.0.0.1:55432` was stopped, so tests ran against the active Docker test target. The tests preserved the main application database and Odoo data. Run the following command from the backend directory.

```powershell
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" tools npx tsx --test --test-concurrency=1 test/catalogue-crud.test.ts test/participants.test.ts test/skills.test.ts test/transport.test.ts test/route-lifecycle-openapi.test.ts
```
