#!/usr/bin/env bash
# =============================================================================
# Polkadex Explorer — SQLite online backup
# =============================================================================
#
# Runs SQLite's online backup against the live explorer.db, integrity-checks
# the copy, gzips it, and rotates old backups by age. WAL-safe — the indexer
# can keep writing while this runs.
#
# Usage:
#   sudo /opt/pdexplorer/backup.sh                # one-shot, uses defaults below
#   sudo SRC=/var/lib/foo.db DEST=/mnt/bak ./backup.sh   # override paths
#
# Designed to be invoked by cron — see /etc/cron.d/pdexplorer-backup, written
# by the `backup` phase of provision-ubuntu.sh.
#
# Restore (with the stack stopped):
#   docker compose -f /opt/pdexplorer/docker-compose.yml down
#   gunzip -c /opt/pdexplorer/backups/explorer-YYYYMMDDTHHMMSSZ.db.gz \
#       > /opt/pdexplorer/data/explorer.db
#   rm -f /opt/pdexplorer/data/explorer.db-wal \
#         /opt/pdexplorer/data/explorer.db-shm
#   chown -R 1000:1000 /opt/pdexplorer/data
#   docker compose -f /opt/pdexplorer/docker-compose.yml up -d backend
#
# Exit codes:
#   0   success
#   1   misconfiguration (missing sqlite3, source DB, or write perms on DEST)
#   2   backup ran but integrity_check failed — old backups retained, new
#       backup left in place under a .CORRUPT suffix for inspection
# =============================================================================

set -euo pipefail

# ---- Configuration (override via env) --------------------------------------
DEPLOY_DIR="${DEPLOY_DIR:-/opt/pdexplorer}"
SRC="${SRC:-$DEPLOY_DIR/data/explorer.db}"
DEST="${DEST:-$DEPLOY_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"        # delete *.db.gz older than this
COMPRESS="${COMPRESS:-gzip}"        # gzip | zstd | none
LOCKFILE="${LOCKFILE:-/var/lock/pdexplorer-backup.lock}"

log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die()  { log "FATAL: $*" >&2; exit 1; }

# ---- Pre-flight ------------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not installed (apt install sqlite3)"
[ -r "$SRC" ] || die "Source DB unreadable: $SRC"
mkdir -p "$DEST" || die "Cannot create backup dir: $DEST"
[ -w "$DEST" ] || die "Backup dir not writable: $DEST"

case "$COMPRESS" in
    gzip|zstd|none) ;;
    *) die "Unknown COMPRESS='$COMPRESS' (expected gzip|zstd|none)" ;;
esac
if [ "$COMPRESS" = "zstd" ]; then
    command -v zstd >/dev/null 2>&1 || die "zstd not installed but COMPRESS=zstd"
fi

# Only one backup at a time. flock auto-releases when this shell exits.
exec 9>"$LOCKFILE"
flock -n 9 || { log "Another backup is already running — exiting."; exit 0; }

# ---- Take the backup -------------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$DEST/explorer-$TS.db"

log "Starting online backup: $SRC -> $TMP"
START=$(date +%s)

# `.backup` uses SQLite's online backup API: WAL-safe, page-by-page copy,
# brief shared locks per page, leaves the source DB untouched.
sqlite3 "$SRC" ".backup '$TMP'"

ELAPSED=$(( $(date +%s) - START ))
SIZE_HUMAN=$(du -h "$TMP" | cut -f1)
log "Backup written in ${ELAPSED}s ($SIZE_HUMAN)"

# ---- Verify ---------------------------------------------------------------
log "Running integrity_check on the copy"
RESULT="$(sqlite3 "$TMP" 'PRAGMA integrity_check;' || true)"
if [ "$RESULT" != "ok" ]; then
    mv "$TMP" "$TMP.CORRUPT"
    log "integrity_check FAILED: $RESULT"
    log "Bad copy retained at: $TMP.CORRUPT (no rotation performed)"
    exit 2
fi
log "integrity_check ok"

# ---- Compress -------------------------------------------------------------
case "$COMPRESS" in
    gzip)
        gzip -9 "$TMP"
        FINAL="$TMP.gz"
        ;;
    zstd)
        zstd -q -19 --rm "$TMP" -o "$TMP.zst"
        FINAL="$TMP.zst"
        ;;
    none)
        FINAL="$TMP"
        ;;
esac
log "Compressed: $FINAL ($(du -h "$FINAL" | cut -f1))"

# ---- Rotate ---------------------------------------------------------------
# Rotate by file age, not count — survives missed cron runs without
# accidentally pruning recent backups.
log "Rotating backups older than $KEEP_DAYS days from $DEST"
DELETED=$(find "$DEST" \
    -maxdepth 1 -type f \
    \( -name 'explorer-*.db' \
       -o -name 'explorer-*.db.gz' \
       -o -name 'explorer-*.db.zst' \) \
    -mtime +"$KEEP_DAYS" -print -delete | wc -l)
log "Rotated $DELETED file(s)"

# ---- Summary --------------------------------------------------------------
COUNT=$(find "$DEST" -maxdepth 1 -type f -name 'explorer-*.db*' ! -name '*.CORRUPT' | wc -l)
TOTAL=$(du -sh "$DEST" 2>/dev/null | cut -f1)
log "Done. $COUNT backup(s) on disk, total $TOTAL"
