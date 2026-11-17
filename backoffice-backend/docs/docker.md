# Backend Docker runbook

Docker runs the backend and an isolated PostgreSQL instance. The frontend runs on the host. This demo uses a synthetic Odoo source schema. The customer's database schema needs separate verification.

This runbook was updated on 2026-11-04 against `compose.yaml`, the Dockerfile, and the verification results. The runtime and tools builds, data transfer, Docker tests, and the host frontend's connection to the Docker API were verified. The full fresh-environment procedure remains unverified.

After adding Vehicles and support for multiple sales orders, the environment was rebuilt and restarted. The main and test databases each had five migrations, the backend and database were healthy, and the importer processed 20 pickings. The final container typecheck, typed lint, and **111/111 backend tests** passed. The frontend passed **73/73 tests**, its production build, and the live read-only smoke test (**1/1**). The initial transfer results below describe that earlier checkpoint. See [recovery.md](recovery.md) for the latest backup and preservation report and [vehicles.md](vehicles.md) and [STATUS.md](STATUS.md) for the new functionality and live demo.

## Directories, addresses, and data

Run the following commands in PowerShell 7 from the backend directory.

```powershell
cd C:/Users/MOHD/Desktop/backoffice/backoffice-backend
```

The requirements are Docker Desktop with Linux containers, Docker Compose v2, and a running Docker Engine. The host PostgreSQL 18 tools are needed only when transferring an existing environment with its backup script.

| Component | Address or purpose |
| --- | --- |
| Compose project | `delivery-backoffice` |
| PostgreSQL on the Compose network | `db:55432` |
| PostgreSQL from the host | `127.0.0.1:55433` |
| Backend from the host | `http://127.0.0.1:3001/api` |
| Frontend on the host | `http://127.0.0.1:3000` |
| Native PostgreSQL before transfer | `127.0.0.1:55432`, a separate preserved cluster |

In the browser, `NEXT_PUBLIC_API_URL` is `http://127.0.0.1:3001/api`. Only containers can use the `db` hostname. The frontend origin is exactly `http://127.0.0.1:3000`. Session and authorization rules apply as before.

The `pg-data` named volume stores PostgreSQL data. The `app-data` volume stores `/app/.local`, including private files and local demo accounts. With the default project name, the actual volume names use the prefix `delivery-backoffice_`. PostgreSQL 18 mounts its volume at `/var/lib/postgresql` and stores data in the image's version-specific `PGDATA` directory.

`./scripts/docker-configure.ps1` creates or verifies seven files in the ignored `.local/docker/secrets` directory and preserves existing files that match the configuration. Keep passwords and connection URLs outside the image, Compose YAML, command output, reports, and Git.

## Images and services

The Dockerfile uses `node:26.13.0-bookworm-slim`. The runtime runs as `node`, contains the compiled `dist` and the dependencies installed by `npm ci --omit=dev`, and starts with `node dist/main.js`. The `.local` volume is writable. Other runtime files are read-only. The image installs the Linux dependencies, including native sharp, during the build. The host's Windows `node_modules` stays outside the image.

The `tools` stage contains development dependencies, TypeScript source, scripts, and tests. It uses `NODE_ENV=development` for the existing demo and import runners. The runtime uses `NODE_ENV=production`. Rebuild the Docker image to update the compiled application.

| Service | Behavior |
| --- | --- |
| `db` | PostgreSQL 18.6 with a health check and three named demo databases |
| `migrate` | One-off application database migration after `db` is ready |
| `backend` | Starts once `db` is healthy and `migrate` succeeds |
| `tools` | Explicit one-off commands under the `tools` profile |
| `tests` | Full suite in the tools image, with source-owner access limited to its own test fixtures |
| `importer` | Optional repeat import under the `importer` profile |

Initializing a new PostgreSQL volume creates the roles, the empty `delivery_backoffice`, `delivery_backoffice_test`, and `odoo_mock` databases, and the source reader grants. The separate `odoo_reader` user has SELECT access and read-only transactions. Seeding the source and application and running imports require explicit commands.

## First transfer of an existing environment

Transfer existing data from a consistent backup.

1. Stop the native backend, importer, demo scripts, and other writers. Leave native PostgreSQL running during the backup. Start the Docker backend and migrations only after restoring into the empty target.
2. Prepare the secrets and validate the Compose configuration.

```powershell
./scripts/docker-configure.ps1
docker compose config --quiet
```

3. Transfer the data once all writers have stopped.

```powershell
./scripts/docker-transfer.ps1 -WritersStopped
```

Use `-WritersStopped` to attest that you stopped the writers. Verify this before setting the flag. The script backs up and restores data **only into empty Docker databases**, including the test database, private files, and required local account manifests. If the target contains data, stop and inspect it before proceeding. This runbook covers transfer into an empty target.

Before switching, compare all tables and exact row digests, versions, relationships, and history across the application, source, and test databases. Compare file sizes and SHA256 hashes. Row counts are also useful alongside these comparisons. Verify that pending or failed files retain their status and that existing accounts, profiles, rosters, visits, and signed results are intact.

**The transfer was completed and verified on 2026-11-04.** The backup is at `.local/backups/20261104T114759Z_373d1214`. Before switching, exact row digests and sequences matched the originals across all three Docker databases. A second check confirmed that the native data was untouched. Hashes matched for four files totaling 379072 bytes and two credential manifests. The read-only ACLs of ten source tables were verified. The transfer preserved the existing data without seeding.

The independent verification is stored in [independent-docker-verification.json](../.local/backups/20261104T114759Z_373d1214/independent-docker-verification.json). The backup and native cluster are preserved. Use only empty volumes for a future transfer. If a transfer fails, stop and inspect the target and the backup before proceeding. See [recovery.md](recovery.md) for the consistent backup procedure.

4. After the comparison passes, stop native PostgreSQL and preserve its data directory. Keep the native API stopped so the Docker backend can listen on port 3001.
5. Start the Docker backend with the standard command below. The transferred application database already contains its data. Standard startup applies only pending migrations.

After switching, the native database is a preserved copy. Future Docker changes require a separate transfer to reach that copy.

## Standard startup, status, and shutdown

Use this procedure with restored or previously prepared volumes.

The current environment also includes the watch importer. Run `docker compose --profile importer up -d --build` to start all backend services. The command below starts the API, database, and migration services. You can also start the importer separately using its profile.

```powershell
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 db migrate backend
Invoke-RestMethod http://127.0.0.1:3001/api/health
```

`migrate` should exit with code 0. A failed migration blocks backend startup. The health endpoint checks connectivity to the application database. Verify the synthetic Odoo import, login, and private files separately to establish that the transfer succeeded.

Open the frontend at `http://127.0.0.1:3000`. Transferred environments use the existing local demo accounts and passwords.

Stop all services in this Compose project, including the active importer.

```powershell
docker compose --profile "*" stop
```

Remove the containers and network while preserving the named volumes.

```powershell
docker compose --profile "*" down
```

Keep the named volumes when shutting down. The `--volumes` or `-v` option and volume pruning can delete stored PostgreSQL data and private files.

## Rebuild after backend changes

```powershell
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 migrate backend
```

The rebuild preserves named volumes and secrets. If the importer was running and its code changed, rebuild and recreate it separately.

```powershell
docker compose --profile importer up -d --build importer
```

## Tools, verification, and manual imports

`--rm` removes one-off containers and preserves named volumes. These commands use the Docker PostgreSQL instance, authentication and authorization guards, and shared domain rules.

```powershell
docker compose --profile tools run --rm tools npm run typecheck
docker compose --profile tools run --rm tools npm run lint
docker compose run --rm tests
```

Prepare the test database through transfer or the fresh-environment procedure below. Tests use the separate `delivery_backoffice_test` database and their own fixtures, preserving the application database. Only the `tests` service receives the additional source-owner secret used to create and remove its isolated source schemas. The application importer uses `odoo_reader`.

Run the test database migration explicitly when needed.

```powershell
docker compose --profile tools run --rm tools npm run migrate -- --test
```

The manual import reads the synthetic Odoo source and updates the application database using the standard authorization rules.

```powershell
docker compose --profile tools run --rm tools npm run import
```

Start the optional watch importer explicitly.

```powershell
docker compose --profile importer up -d importer
docker compose --profile importer logs --tail=100 importer
```

Stop the importer separately.

```powershell
docker compose --profile importer stop importer
```

## Separate fresh environment

End-to-end verification of this fresh-environment procedure is pending. The verified transfer above covered an existing environment.

Use this procedure to create new synthetic data in empty volumes. Choose **a new, unused project name**, such as `delivery-backoffice-fresh`, to create separate named volumes. An existing project name may point to populated volumes.

The published ports match those of the standard environment. Stop the standard environment first and preserve its data.

```powershell
docker compose --profile "*" stop
./scripts/docker-configure.ps1
docker compose -p delivery-backoffice-fresh up -d db
docker compose -p delivery-backoffice-fresh ps
```

Once `db` is healthy, prepare the fresh source, application, and test databases. The source script uses Bash.

```powershell
docker compose -p delivery-backoffice-fresh exec -T db bash /opt/backoffice/docker/source-setup.sh
docker compose -p delivery-backoffice-fresh --profile tools build tools
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run migrate
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run migrate -- --test
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run seed
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run seed -- --test
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run import
docker compose -p delivery-backoffice-fresh up -d --build backend
```

Stop if any command fails. `seed` creates synthetic local accounts in the fresh `app-data` volume. Run it only for this new environment to preserve the accounts in the existing one. If needed, copy the new accounts to a separate ignored local file while keeping the contents out of command output.

```powershell
docker compose -p delivery-backoffice-fresh cp backend:/app/.local/demo-accounts.json .local/docker/fresh-demo-accounts.json
```

Run tests for the fresh project.

```powershell
docker compose -p delivery-backoffice-fresh run --rm tests
```

Return to the preserved standard project.

```powershell
docker compose -p delivery-backoffice-fresh --profile "*" stop
docker compose up -d
```

The fresh environment keeps its own named volumes. This procedure preserves those volumes and the native cluster.

## Verified results on 2026-11-04

The environment used Docker 29.9.2, Compose 5.6.1, Node.js 26.13.0 on Linux, and PostgreSQL 18.6.

| Check | Result |
| --- | --- |
| Runtime/tools Docker build | PASS |
| Runtime user and private storage | UID 1000. Writes to private files were verified |
| Linux sharp | PNG encode/decode PASS |
| Production `npm ci` audit | 0 vulnerabilities |
| Transfer of three databases into an empty target | Exact row digests and sequences matched. Native data was preserved |
| Files and credentials | SHA256 hashes matched for 4 files totaling 379072 bytes and 2 credential manifests |
| Source ACL | `odoo_reader` has read-only access to 10 tables |
| Docker typecheck and typed lint | PASS |
| Docker tests | 95/95 PASS after participant-skills implementation; initial Docker transfer phase was 87/87 |
| Host frontend → Docker API, read-only client smoke | 1/1 PASS |
| Compose status | `backend` and `db` healthy. `migrate` exited with 0 and printed `Applied migrations: []` |
| Optional importer | The `importer` profile was running on a 60-second interval. The first cycle succeeded with 20 pickings |
| Native environment | The API and PostgreSQL were stopped and the source cluster was preserved |

The independent report also compared columns, indexes, owners, foreign and primary keys, UNIQUE and EXCLUDE constraints, ACLs, and roles. The only textual difference was the grouping of an associative AND expression in `person_check1`. The expressions are logically equivalent. The report records the parentheses difference explicitly, so the full schema SQL is not assumed to match byte for byte.

The full tools install, including development dependencies, reported 10 moderate vulnerabilities in the lockfile at that checkpoint. No dependency updates were applied during that task. The separate production installation audit reported 0 vulnerabilities.

The transfer check used the existing frontend and Docker API. The read-only smoke test passed 1/1 with the existing tsx `DEP0205` warning. The full frontend typecheck, lint, tests, and build were not rerun for this checkpoint. After reloading the browser, Source sync showed a successful import of 20 pickings on 04 Nov at 12:57. Refresh history preserved the same UI. The browser console was `[]`. [Source sync screenshot](../../backoffice-frontend/docs/screenshots/backend-docker-source-sync-2026-11-04.jpg).

The PASS results above apply to the transferred environment and the stated verification scope. End-to-end verification of the fresh environment is pending.

Keep verification artifacts limited to non-sensitive reports, counts, digests, and command results. Keep secret files, cookies, passwords, private file contents, and full connection URLs out of published artifacts.

## References checked

- Separate build and runtime targets. [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- Debian slim variants for Node 26.13.0. [Node official images](https://hub.docker.com/_/node)
- Lockfile-based installation with `--omit=dev`. [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
- Platform-specific Linux/glibc binaries and cross-platform lockfile considerations. [sharp installation](https://sharp.pixelplumbing.com/install/)
- PostgreSQL 18 volume layout and initialization scripts that run only for an empty data directory. [PostgreSQL official image](https://github.com/docker-library/docs/blob/master/postgres/README.md)
- Healthy dependencies and successful migration jobs. [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)
- The tools and importer profiles and a separate fresh project. [Compose profiles](https://docs.docker.com/compose/how-tos/profiles/) · [Project names](https://docs.docker.com/compose/how-tos/project-name/)
