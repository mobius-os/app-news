#!/bin/sh
# Declares the cron entry for "news-2" across container restarts.
# /var/spool/cron/crontabs/ lives inside the container, not on the
# /data volume — so it is empty after every Railway redeploy. FastAPI lifespan
# parses ENTRY below without executing this app-owned script, then rewrites a
# current supervised entry before cron is allowed to start.
#
# Drop any prior line for this job path, then re-add the canonical
# entry. Idempotent (no duplicates) AND self-healing: a stale entry
# written before the app id was appended is replaced, not skipped.
# grep -vF on the full job path is prefix-safe (news vs news-2). A
# contrived line that puts this exact path in ITS OWN args would be an
# over-match, but it self-heals on the next boot reconciliation; the install-side
# delete path (_crontab_without_app) anchors on the command precisely.
#
# Capture the existing crontab ONCE and check rc. Piping a second live
# crontab listing into the rewrite risks a transient empty read collapsing
# the whole crontab to just this one line.
#
# `crontab -l` exits non-zero for TWO different reasons and they must NOT be
# treated the same: (a) "no crontab for <user>" — genuinely empty, nothing to
# preserve, safe to install just this entry; (b) a real read error (spool
# unreadable, etc.) — the crontab may be FULL of other apps' lines we just
# can't see, so rewriting from an empty read would DROP every one of them.
# We distinguish by the stderr message: only the benign "no crontab" case
# installs the bare entry; a real error leaves the crontab untouched and lets
# the next boot retry, rather than silently wiping other apps' jobs.
ENTRY="0 10 * * * API_BASE_URL=http://localhost:8000 python3 /data/platform/backend/scripts/app-job-runner.py --scheduled 61 /data/apps/news-2/fetch.sh"
ERRFILE=$(mktemp)
EXISTING=$(crontab -u mobius -l 2>"$ERRFILE"); RC=$?
STATUS=0
if [ "$RC" -eq 0 ]; then
  # Authoritative read — keep every other app's line, replace only ours.
  (printf '%s\n' "$EXISTING" | grep -vF "/data/apps/news-2/fetch.sh"; echo "$ENTRY") \
    | crontab -u mobius - || STATUS=$?
elif grep -qi 'no crontab for' "$ERRFILE"; then
  # Genuinely no crontab yet — safe to install just this entry; lifespan
  # reconciles every other live app declaration before cron starts.
  echo "$ENTRY" | crontab -u mobius - || STATUS=$?
else
  # A real read error (not "no crontab"): do NOT rewrite, or we'd drop every
  # other app's entry from a partial/empty read. Leave the crontab as-is and
  # report failure; the durable declaration is already safe for a later retry.
  echo "init-cron(news-2): crontab read error (rc=$RC); leaving crontab unchanged" >&2
  cat "$ERRFILE" >&2
  STATUS=$RC
fi
rm -f "$ERRFILE"
exit "$STATUS"
