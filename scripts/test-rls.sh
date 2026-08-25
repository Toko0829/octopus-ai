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

TESTS_DIR="$(dirname "$0")/../supabase/tests"

# Every suite in the directory, rather than a hardcoded list. A new suite that has
# to be registered in two places is a new suite that eventually runs in neither,
# and the failure mode is silent: the script still exits 0 having tested less.
#
# -v ON_ERROR_STOP=1 so a failed assertion fails the script rather than scrolling
# past. A test suite that cannot fail the build is documentation, not a gate.
status=0
for suite in "$TESTS_DIR"/*.sql; do
  echo "== $(basename "$suite")"
  # Not `exec`, and not `set -e`'s early exit: one failing suite must not hide the
  # results of the others, since knowing whether a break is narrow or broad is
  # most of the diagnosis.
  if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$suite"; then
    status=1
  fi
done

exit "$status"
