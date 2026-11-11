#!/usr/bin/env bash
set -Eeuo pipefail

# The official postgres entrypoint invokes this only for a new data directory.
# Use its temporary local socket, not the Compose TCP hostname during init.
sql_dir="${BACKOFFICE_SQL_DIR:-/opt/backoffice/local}"
read_secret() {
  local secret="/run/secrets/$1"
  [[ -r "$secret" && -s "$secret" ]] || { printf 'Missing required PostgreSQL secret file.\n' >&2; return 1; }
  cat -- "$secret"
}
[[ -r "$sql_dir/roles.sql" ]] || { printf 'Shared roles.sql is unavailable.\n' >&2; exit 1; }
PGPASSWORD="$(read_secret admin_password)"
BACKOFFICE_LOCAL_APP_PASSWORD="$(read_secret app_password)"
BACKOFFICE_LOCAL_SOURCE_OWNER_PASSWORD="$(read_secret source_owner_password)"
BACKOFFICE_LOCAL_READER_PASSWORD="$(read_secret source_reader_password)"
export PGPASSWORD BACKOFFICE_LOCAL_APP_PASSWORD BACKOFFICE_LOCAL_SOURCE_OWNER_PASSWORD BACKOFFICE_LOCAL_READER_PASSWORD
if ! psql -X -q --username "${POSTGRES_USER:-backoffice_local_admin}" --dbname postgres --set ON_ERROR_STOP=1 --file "$sql_dir/roles.sql" >/dev/null 2>&1; then
  printf 'PostgreSQL roles/database initialization failed; existing state was retained for inspection.\n' >&2
  exit 1
fi
unset PGPASSWORD BACKOFFICE_LOCAL_APP_PASSWORD BACKOFFICE_LOCAL_SOURCE_OWNER_PASSWORD BACKOFFICE_LOCAL_READER_PASSWORD
printf 'PostgreSQL roles, three empty databases and source read-only grants are ready.\n'
