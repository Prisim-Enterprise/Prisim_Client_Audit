#!/usr/bin/env bash
# =====================================================
# Isolated database test run (CI only).
#
# Starts a throw-away local Supabase stack with the Supabase CLI (Docker),
# applies every migration in supabase/migrations to a fresh database, then
# runs the pgTAP suite in supabase/tests/database two ways:
#   1. `supabase test db` (official pg_prove runner: pass/fail per file)
#   2. each file through psql, keeping every TAP line, so the exact number
#      of assertions executed / passed / failed is reported
#
# Safety: this script never contacts a hosted project. It refuses to run when
# the checkout is linked to a project or when Supabase credentials are present
# in the environment, and it uses only the local stack's default development
# credentials (postgres/postgres on 127.0.0.1).
#
# Usage (from the repository root, after `npm ci`):  bash scripts/ci-db-test.sh
# Output: test-results/db/{official.txt,<file>.tap,summary.txt}
# =====================================================
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=test-results/db
mkdir -p "$OUT"

if [ -e supabase/.temp/project-ref ] || [ -e supabase/.temp/linked-project.json ]; then
  echo "Refusing to run: this checkout is linked to a hosted Supabase project (supabase/.temp)." >&2
  exit 2
fi
for var in SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_ID SUPABASE_SERVICE_ROLE_KEY; do
  if [ -n "${!var:-}" ]; then
    echo "Refusing to run: $var is set. Database tests must not have hosted credentials." >&2
    exit 2
  fi
done

SUPABASE="npx --no-install supabase"
export SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1

# Services the database tests do not use. Auth (gotrue) and Storage
# (storage-api) stay: they create the auth.* and storage.* schemas the
# migrations and tests depend on.
EXCLUDE=imgproxy,mailpit,studio,edge-runtime,logflare,vector,realtime,postgres-meta,supavisor

echo "::group::Start isolated Supabase stack"
$SUPABASE start -x "$EXCLUDE"
echo "::endgroup::"

# The CLI applies migrations on start; reset once more without seed data so
# the tests see exactly the migrations, nothing else.
echo "::group::Apply all migrations to a fresh database (no seed)"
$SUPABASE db reset --no-seed
echo "::endgroup::"

DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E '^supabase_db_' | head -n 1)
if [ -z "$DB_CONTAINER" ]; then
  echo "Database container not found." >&2
  exit 1
fi
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -X -A -t \
  -c "SELECT 'postgres ' || current_setting('server_version') || ' | ' || string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension" \
  | tee "$OUT/environment.txt"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -X -A -t \
  -c "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version" \
  | tee "$OUT/migrations.txt"

echo "::group::Official runner: supabase test db"
set +e
$SUPABASE test db 2>&1 | tee "$OUT/official.txt"
official=${PIPESTATUS[0]}
set -e
echo "::endgroup::"

echo "::group::Per-assertion TAP"
total=0; passed=0; failed=0; files_failed=0
: > "$OUT/summary.txt"
for file in supabase/tests/database/*.test.sql; do
  name=$(basename "$file" .test.sql)
  set +e
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -X -q -A -t -v ON_ERROR_STOP=1 -f - \
    < "$file" > "$OUT/$name.tap" 2>&1
  status=$?
  set -e
  ok=$(grep -cE '^ok [0-9]+' "$OUT/$name.tap" || true)
  notok=$(grep -cE '^not ok [0-9]+' "$OUT/$name.tap" || true)
  total=$((total + ok + notok)); passed=$((passed + ok)); failed=$((failed + notok))
  if [ "$status" -ne 0 ] || [ "$notok" -gt 0 ]; then files_failed=$((files_failed + 1)); fi
  printf '%-40s executed %4d  passed %4d  failed %4d  psql-exit %d\n' "$name" "$((ok + notok))" "$ok" "$notok" "$status" \
    | tee -a "$OUT/summary.txt"
  grep -E '^not ok|ERROR|# +(Failed|got|expected|Looks like)' "$OUT/$name.tap" | head -n 40 || true
done
printf 'TOTAL executed %d  passed %d  failed %d  files-with-failures %d  official-runner-exit %d\n' \
  "$total" "$passed" "$failed" "$files_failed" "$official" | tee -a "$OUT/summary.txt"
echo "::endgroup::"

$SUPABASE stop --no-backup >/dev/null 2>&1 || true

if [ "$official" -ne 0 ] || [ "$failed" -gt 0 ] || [ "$files_failed" -gt 0 ]; then
  exit 1
fi
