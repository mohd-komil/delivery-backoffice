# Private document versions — 2026-11-11

`DocumentVersions1793700900000` adds nullable document purpose/version/source and a self-reference to the replaced file. Existing rows retain null metadata; there is no invented version history. New local uploads start at version 1. Replacing a known version increments it; replacing a legacy file starts the recorded sequence at 1 while keeping the legacy predecessor unknown.

`POST /api/deliveries/:id/files` accepts optional `documentPurpose` (`general`, `instruction`, `drawing`) and `supersedesFileId`. A replacement must keep the same delivery, appointment, exact source line and issue. Delivery row locking and a partial unique index prevent parallel current replacements. A pending/failed upload never hides the last ready document. Original private bytes and metadata remain available to authorized Backoffice readers.

Crew lists current ready documents for its current assignment and exact source lines. Direct older-version URLs still recheck assignment, visit state and line scope. Documents on completed/cancelled visits are not exposed through the Crew document endpoint. General delivery files remain separate from line documents.

Crew Finish captures document metadata on the server inside the same transaction as the immutable result. `documentSnapshot` contains the file ID, exact item ID, purpose, recorded version, upload time/source and uploader. New versions uploaded later cannot replace these report references. Legacy results without a snapshot remain explicitly unrecorded. No source database/Odoo files are inferred or modified.

Verification: `test/files.test.ts` runs real PostgreSQL migrations in a uniquely owned schema inside `delivery_backoffice_test`, checks replay, line separation, immutable bytes, previous-version access, scope mismatch, current replacement conflicts and legacy null preservation. Existing real HTTP Crew authorization tests remain applicable. From `backoffice-backend`:

```powershell
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" -v "${PWD}/scripts:/app/scripts:ro" tests npx tsx --test test/files.test.ts
```

The development migration is not a production rollout plan. The `down` method refuses destructive loss of document history.
