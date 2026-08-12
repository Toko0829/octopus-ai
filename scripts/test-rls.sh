#!/usr/bin/env bash
# Run the pgTAP RLS suite against a database.
#
# Everything runs inside a transaction that ROLLBACKs, so it is safe against a
# live database and leaves no fixtures behind.
#
#   DATABASE_URL="postgresql://..." ./scripts/test-rls.sh
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required." >&2
  echo "Supabase gives you one under Project Settings > Database > Connection string." >&2
  exit 1
fi

# -v ON_ERROR_STOP=1 so a failed assertion fails the script rather than scrolling
# past. A test suite that cannot fail the build is documentation, not a gate.
exec psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../supabase/tests/rls_membership.sql"
