"""Bounded report history: delete daily report files older than the window.

fetch.sh writes reports/<YYYY-MM-DD>.html plus .meta.json and .run.json
sidecars every day and nothing else ever removes them, so storage grows by
three files a day forever. After a successful digest, fetch.sh runs:

    python3 report_retention.py <api_base> <app_id> <token> <today> [keep_days]

Only names that start with an ISO date older than `today - keep_days` are
deleted; anything else in reports/ is left alone. Failures are reported on
stderr and never fail the digest run.
"""
import datetime as dt
import json
import re
import sys
import urllib.parse
import urllib.request

KEEP_DAYS = 90
_DATED_NAME = re.compile(r"^(\d{4}-\d{2}-\d{2})\.")


def expired_report_names(names, today, keep_days=KEEP_DAYS):
    """Names whose leading date is strictly before `today - keep_days`."""
    cutoff = dt.date.fromisoformat(today) - dt.timedelta(days=keep_days)
    expired = []
    for name in names:
        match = _DATED_NAME.match(name)
        if not match:
            continue
        try:
            day = dt.date.fromisoformat(match.group(1))
        except ValueError:
            continue
        if day < cutoff:
            expired.append(name)
    return sorted(expired)


def _request(base, token, method, path):
    req = urllib.request.Request(
        base + path, method=method, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read()
    return json.loads(body.decode("utf-8")) if body else None


def list_report_names(base, app_id, token):
    names, cursor, seen = [], None, set()
    for _ in range(50):
        params = {"limit": "500"}
        if cursor:
            params["cursor"] = cursor
        path = (f"/api/storage/apps-list/{urllib.parse.quote(app_id, safe='')}/reports?"
                + urllib.parse.urlencode(params))
        data = _request(base, token, "GET", path) or {}
        for entry in data.get("entries", []):
            if entry.get("type") == "file" and isinstance(entry.get("name"), str):
                names.append(entry["name"])
        cursor = data.get("next_cursor")
        if not cursor or cursor in seen:
            break
        seen.add(cursor)
    return names


def main(argv):
    base, app_id, token, today = argv[1].rstrip("/"), argv[2], argv[3], argv[4]
    keep_days = int(argv[5]) if len(argv) > 5 else KEEP_DAYS
    expired = expired_report_names(list_report_names(base, app_id, token), today, keep_days)
    deleted = 0
    for name in expired:
        path = (f"/api/storage/apps/{urllib.parse.quote(app_id, safe='')}/reports/"
                + urllib.parse.quote(name, safe=""))
        try:
            _request(base, token, "DELETE", path)
            deleted += 1
        except Exception as exc:  # keep going; the next run retries the rest
            print(f"report retention: could not delete {name}: {exc}", file=sys.stderr)
    print(f"report retention: deleted {deleted} of {len(expired)} expired file(s)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--expired":
        # Test seam: `--expired <json {names, today, keep_days}>` prints the plan.
        spec = json.loads(sys.argv[2])
        print(json.dumps(expired_report_names(spec["names"], spec["today"],
                                              spec.get("keep_days", KEEP_DAYS))))
        sys.exit(0)
    sys.exit(main(sys.argv))
