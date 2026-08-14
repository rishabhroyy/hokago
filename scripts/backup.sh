#!/usr/bin/env sh
# hokago — host-side backup: postgres dump + config dir (artwork/fonts/avatars/
# downloads). The API also snapshots the DB into /config/db-backups/ before
# every migration, so restores here only ever deal with table state.
#
#   ./scripts/backup.sh [outdir]   (default: ./data/backups)
#
# Needs: docker + compose (pg_dump runs inside the postgres container, no
# host client required). Restore instructions: AGENTS.md §Backup & restore.
set -eu

out="${1:-./data/backups}"
cfg="${HOKAGO_CONFIG_DIR:-./data/config}"
mkdir -p "$out"
stamp="$(date +%Y%m%d-%H%M%S)"

echo "dumping postgres → $out/hokago-db-$stamp.sql.gz"
docker compose exec -T postgres \
  pg_dump --no-owner "postgresql://hokago:${POSTGRES_PASSWORD:-hokago}@localhost:5432/hokago" \
  | gzip > "$out/hokago-db-$stamp.sql.gz"

echo "packing config dir ($cfg) → $out/hokago-config-$stamp.tar.gz"
tar -czf "$out/hokago-config-$stamp.tar.gz" -C "$(dirname "$cfg")" "$(basename "$cfg")"

ls -lh "$out"/hokago-*"$stamp"*
echo "backup complete: $out"