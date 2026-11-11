# Educational backup and restore check

**Since 2026-11-04 the active backend uses Docker.** The legacy `postgres-*.ps1` scripts operate only on the preserved native cluster and native `.local/files`; they do not back up current Docker volumes or changes made after switchover. Use the Docker-specific backup below for the active environment. The transfer snapshot and independent verification are recorded in [Docker runbook](docker.md). Do not treat the saved native cluster as an up-to-date Docker backup or restart it to resolve a Docker connection problem.

## Current Docker backup

The active Docker deployment now has a separate `scripts/docker-backup.ps1`. Run it from the backend directory after stopping the API, importer and all test/tool/source writers; keep only the database service running:

```powershell
docker compose --profile importer stop backend importer
./scripts/docker-backup.ps1 -WritersStopped
docker compose --profile importer up -d --wait
```

Run each command only after the preceding command succeeds. The script checks the exact Compose project, mounted PostgreSQL/application volumes and inactive clients. It copies all three current databases, globals, complete app-data and seven recovery-secret files into a new protected, Git-ignored backup directory. The completed manifest records table row digests, sequences, schema/index/constraint/ACL metadata, exact app-data names/sizes/SHA-256, archive hashes and secret-copy hashes. Archive file bytes are independently read back and compared before completion. It never starts or connects to the native cluster and never removes volumes.

Latest vehicle-migration backup: `.local/backups/docker_20261104T150953Z_2075f529/docker-backup-manifest.json`, with `independent-vehicle-migration-verification.json`. All previous main rows/schema/ACL, source/test state and complete app-data matched immediately after the additive vehicle migration. The subsequent teaching source seed added only its three new records; all original source rows/schema also matched, including after repetition. Later normal API/import/browser changes are newer than this recovery point. An earlier participant-skills backup remains at `.local/backups/docker_20261104T125802Z_10dabf0b/docker-backup-manifest.json`. These are backup and migration-preservation checks, not a fresh full Docker restore drill. Recovery bundles contain private credentials and hashes; do not publish them. The following native instructions remain available for the preserved native environment only.

These commands apply only to this task-owned local PostgreSQL cluster, the `delivery_backoffice` and `odoo_mock` databases, and the application's private `.local/files` directory. They do not connect to customer infrastructure or perform production recovery.

Use PowerShell 7 in `backoffice-backend`. PostgreSQL 18 tools default to `C:/Program Files/PostgreSQL/18/bin`; both scripts accept `-PostgresBin` and the same task-owned `-Port` as setup. The existing ownership marker, loopback port and actual server data directory are verified before database access.

## Create a usable backup

1. Stop the backend, importer, development scenario and any source-fixture writer. Leave PostgreSQL running. Prevent other clients from writing until the command finishes.
2. Run:

```powershell
./scripts/postgres-backup.ps1 -WritersStopped
```

The flag records that the operator has stopped writers. The script does not kill processes or infer that a browser is idle. It refuses to mark a backup usable without this explicit flag. A PostgreSQL dump has its own consistent database snapshot, but application database, source database and private files have **no shared transaction**. Their joint recovery point relies on the stopped-writer procedure. Do not claim a live run is an atomic backup.

The command creates a unique `.local/backups/<UTC timestamp>_<suffix>/` containing `application.dump`, `source.dump`, `files/` and a manifest. Dumps use PostgreSQL's custom archive format. The manifest records actual table counts, source-filter results, file metadata/lifecycle status, sizes and SHA256 hashes. All ready file records must have matching physical bytes; a missing/incomplete ready file causes failure rather than a false success. Pending and failed uploads remain pending/failed and are not promoted to ready.

The backup is local and ignored by Git. It contains synthetic operational data, password hashes, session hashes and private files; protect it like application data. Credentials themselves are not copied into the backup or printed by the scripts. Keep the existing `.local/postgres-credentials.json` and `.local/demo-accounts.json` privately through your normal local secret process. Hashes detect accidental corruption, not an attacker replacing both files and manifest.

An interrupted backup leaves its unique directory for inspection. Only a directory with a completed `manifest.json` is eligible for a restore check. The scripts do not delete partial artifacts.

## Verify restoration without replacing anything

Pass the exact path printed by backup:

```powershell
./scripts/postgres-restore-check.ps1 -BackupPath '.local/backups/<printed backup directory>'
```

This accepts backups only inside this project's `.local/backups`. It validates archive/file hashes before creating targets, generates new database names, and refuses any collision:

- `delivery_backoffice_restore_<UTC timestamp>_<suffix>`, owned by `delivery_app`;
- `odoo_mock_restore_<UTC timestamp>_<suffix>`, owned by `odoo_seed`;
- `.local/restore-checks/<timestamp>_<suffix>/files` for a new private-file copy.

It does not replace, rename, reset or drop an existing database. It does not overwrite `.local/files`, modify `.env`, switch the running application's connection, or activate restored sessions. Application configuration intentionally permits only the canonical application/test database names; inspecting a clone is a restore check, not an activation flow.

Archives restore with `--no-owner --no-privileges --single-transaction --exit-on-error` under the intended clone owner. The clone database denies PUBLIC connection. Archive roles/privileges do not overwrite the cluster's current roles or passwords.

Verification compares every public table name and exact row count against the manifest, reruns the repository's source filter and compares the exact IDs, compares file-record metadata, verifies every copied file's size/hash, and checks that every ready record has the expected bytes. A `verification.json` records the new names and result. Pending/failed records remain unavailable; the script does not fabricate completed uploads or infer domain completion from restored source states.

New clone databases, restored files, reports and failed restore targets remain available for inspection. Cleanup is a separate, explicitly selected action against exact clone names/paths. These scripts contain no database drop or recursive delete operation. Do not remove the canonical databases or `.local` to “start fresh.”

## Recovery limits

This is a tested local restore exercise. It does not provide encrypted/off-site retention, transaction-log point-in-time recovery, or automatic switchover. It restores the state already backed up: unresolved issues, return requests, missing signatures and pending uploads remain unresolved. Missing ready-file bytes cannot be recreated from database metadata; recover the original private-file snapshot.

If the source changes after backup, its restored clone still represents the recorded teaching source state. Real Odoo schema/version compatibility remains unverified. Reimport is a reconciliation operation and must not erase local history or prior signed snapshots.

PostgreSQL 18 reference: [pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html), [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html).

## Verified local exercise — 2026-11-03

Backend/importer/demo/source writers were stopped before backup. Both commands completed successfully on PostgreSQL 18.6:

```powershell
./scripts/postgres-backup.ps1 -WritersStopped
./scripts/postgres-restore-check.ps1 -BackupPath '.local/backups/20261103T111354Z_11ae0fc1'
```

The exercise retained these new targets for inspection:

- Application: `delivery_backoffice_restore_20261103111401_fa28a190` — 20 deliveries.
- Teaching source: `odoo_mock_restore_20261103111401_fa28a190` — 30 pickings; exact filter IDs 1–20.
- Private snapshot: `.local/restore-checks/20261103111401_fa28a190/files` — 2 ready files, 0 pending, 0 failed.
- Report: `.local/restore-checks/20261103111401_fa28a190/verification.json`.

Every restored public table name/count, both dump hashes, source-filter results, file metadata, byte sizes and SHA256 hashes matched the manifest. The canonical databases, live private files and `.env` were unchanged. These named clones are outputs from this initial exercise; the later verified snapshot below captures the final corrected demo state.

### Latest verified snapshot after the signed evidence correction

After the initially generated invalid PNG was preserved as a failed file and replaced through an audited reopen, new evidence, signed corrective result and explicit reclose, all canonical writers were stopped again. The backup and restore check were repeated successfully:

```powershell
./scripts/postgres-backup.ps1 -WritersStopped
./scripts/postgres-restore-check.ps1 -BackupPath '.local/backups/20261103T112634Z_4f83ca86'
```

Latest retained targets:

- Application: `delivery_backoffice_restore_20261103112642_10609c25` — 20 deliveries.
- Teaching source: `odoo_mock_restore_20261103112642_10609c25` — 30 pickings; exact filter IDs 1–20.
- Private snapshot: `.local/restore-checks/20261103112642_10609c25/files` — 3 physical files; 2 ready records, 0 pending, 1 failed.
- Report: `.local/restore-checks/20261103112642_10609c25/verification.json`.

All table counts, archive/file hashes, source-filter IDs and file metadata matched. An additional exact JSON comparison of every restored Delivery aggregate against the canonical database passed, including signed corrective versions, original signed snapshots, completion and reopen history. The preserved invalid original file remains failed; restoration did not promote it to ready. Both exercises and their clones remain available; no database or live file was replaced or deleted.
