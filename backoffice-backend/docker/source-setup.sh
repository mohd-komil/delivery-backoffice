#!/usr/bin/env bash
set -Eeuo pipefail

# Explicit teaching-fixture command. Never part of database or API startup.
sql_dir="${BACKOFFICE_SQL_DIR:-/opt/backoffice/local}"
secret='/run/secrets/source_owner_password'
[[ -r "$secret" && -s "$secret" ]] || { printf 'Source-owner secret is unavailable.\n' >&2; exit 1; }
for file in source-schema.sql source-seed.sql; do
  [[ -r "$sql_dir/$file" ]] || { printf 'Teaching source SQL is unavailable.\n' >&2; exit 1; }
done
PGPASSWORD="$(cat -- "$secret")"
export PGPASSWORD
for file in source-schema.sql source-seed.sql; do
  psql -X -q --host "${PGHOST:-db}" --port "${PGPORT:-55432}" --username odoo_seed --dbname odoo_mock --set ON_ERROR_STOP=1 --file "$sql_dir/$file"
done
unset PGPASSWORD
printf 'Teaching source schema and missing deterministic fixture rows are ready.\n'
