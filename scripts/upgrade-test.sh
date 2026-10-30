#!/usr/bin/env bash
# Failure-suite item 8: upgrade DBOS one patch and one minor version under live data and
# check that (a) DBOS migrations are never blocked by ops.*, (b) a workflow killed under the old
# version recovers under the new one, (c) ops.v_runs and the health views keep working.
#   PG_ADMIN_URL=postgres://postgres@127.0.0.1:5433/postgres scripts/upgrade-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN=${PG_ADMIN_URL:-postgres://postgres@127.0.0.1:5433/postgres}
DB_URL=${ADMIN%/*}/spike_t8
WORK=${UPGRADE_WORKDIR:-$(mktemp -d)}
CHAIN=(${DBOS_CHAIN:-5.2.0 5.2.11 5.3.0})
psql_db() { psql "$DB_URL" -Atc "$1"; }

psql "$ADMIN" -qc "drop database if exists spike_t8 with (force)" -c "create database spike_t8"

install_dbos() {
  local v=$1 dir=$WORK/dbos-$1
  if [ "$v" = "$(node -p "require('./node_modules/@dbos-inc/dbos-sdk/package.json').version")" ]; then
    echo "$PWD/scripts"; return
  fi
  if [ ! -d "$dir/node_modules/@dbos-inc/dbos-sdk" ]; then
    mkdir -p "$dir"
    (cd "$dir" && echo '{"type":"module","private":true}' > package.json && npm install --silent --no-audit --no-fund --save-exact "@dbos-inc/dbos-sdk@$v" >&2) \
      || { echo "failed to install @dbos-inc/dbos-sdk@$v" >&2; return 1; }
  fi
  cp scripts/upgrade-probe.mjs "$dir/"
  echo "$dir"
}

first=${CHAIN[0]}
dir=$(install_dbos "$first") || exit 1
echo "== seed with DBOS $first"
timeout 60 node "$dir/upgrade-probe.mjs" seed "$DB_URL" "probe-pending-$first" || true
pending="probe-pending-$first"
psql "$DB_URL" -q -f sql/001_ops_schema.sql
psql "$DB_URL" -q -f sql/003_connections.sql
psql "$DB_URL" -q -f sql/004_calendar_prep.sql
psql "$DB_URL" -q -f sql/005_attention.sql
psql "$DB_URL" -q -f sql/006_prep_holds.sql
psql "$DB_URL" -q -f sql/007_brief_view.sql
psql "$DB_URL" -q -f sql/008_push.sql
psql "$DB_URL" -q -f sql/009_push_deliveries.sql
psql "$DB_URL" -q -f sql/010_agent_pause.sql
psql "$DB_URL" -q -f sql/011_inbox_triage.sql
psql "$DB_URL" -q -f sql/002_views.sql
echo "migrations applied: $(psql_db 'select version from dbos.dbos_migrations')"
echo "v_runs: $(psql_db "select string_agg(workflow_id || '=' || dbos_status, ', ' order by workflow_id) from ops.v_runs")"

fail=0
for v in "${CHAIN[@]:1}"; do
  dir=$(install_dbos "$v") || exit 1
  before=$(psql_db 'select version from dbos.dbos_migrations')
  echo "== upgrade -> DBOS $v ($pending before: $(psql_db "select status from dbos.workflow_status where workflow_uuid='$pending'"))"
  if timeout 90 node "$dir/upgrade-probe.mjs" recover "$DB_URL" "$pending"; then rec=ok; else rec=FAILED; fail=1; fi
  after=$(psql_db 'select version from dbos.dbos_migrations')
  vr=$(psql_db "select string_agg(workflow_id || '=' || run_state, ', ' order by workflow_id) from ops.v_runs where workflow_id like 'probe-%'" 2>&1) || fail=1
  hq=$(psql_db "select count(*) from ops.agent_health" 2>&1) && aq=$(psql_db "select count(*) from ops.attention_queue" 2>&1) || fail=1
  deps=$(psql_db "select count(*) from pg_depend d join pg_rewrite r on r.oid=d.objid join pg_class c on c.oid=r.ev_class join pg_namespace n on n.oid=c.relnamespace join pg_class rc on rc.oid=d.refobjid join pg_namespace rn on rn.oid=rc.relnamespace where n.nspname='ops' and rn.nspname='dbos'")
  echo "   migrations $before -> $after | recovery $rec | v_runs: $vr | agent_health rows=$hq attention rows=$aq | ops->dbos deps=$deps"
  # Leave a fresh mid-flight workflow under THIS version for the next hop.
  pending="probe-pending-$v"
  timeout 60 node "$dir/upgrade-probe.mjs" seed "$DB_URL" "$pending" >/dev/null 2>&1 || true
done
[ $fail -eq 0 ] && echo "UPGRADE TEST: PASS" || { echo "UPGRADE TEST: FAIL"; exit 1; }
