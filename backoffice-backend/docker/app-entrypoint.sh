#!/bin/sh
set -eu

# Compose secrets stay out of image layers and the container's configured env.
# The application still validates all URLs and never receives owner/admin access.
export DATABASE_URL="$(cat /run/secrets/database_url)"
export TEST_DATABASE_URL="$(cat /run/secrets/test_database_url)"
export ODOO_DATABASE_URL="$(cat /run/secrets/odoo_database_url)"
exec "$@"
