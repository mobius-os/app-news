# News

A daily AI-curated news digest for [Möbius](https://github.com/mobius-os). Each morning a Claude (or Codex) sub-agent searches the web for top stories across world, business, tech, science, sports, and culture, then drops a readable HTML digest into the app for you to read.

## Install

### Via the App Store (recommended)

Open the **App Store** mini-app in Möbius, search for "News", tap **Install**.

### Via paste-a-URL

In the App Store, choose **Install from URL** and paste:

```
https://raw.githubusercontent.com/mobius-os/app-news/main/mobius.json
```

Möbius will fetch the manifest, show you the requested permissions and schedule, and install with one tap.

## Customize

From the **Settings** tab inside the app:

- **Editorial brief** — plain-English description of what you want in the digest: topics, regions, beats, sources, tone. This is the main lever; the more specific you are, the better the report. A **Reset to default** button restores the seeded brief.
- **Agent / Model** — which connected provider + model generates the digest (Claude Code or OpenAI Codex), using the same visible model list as chat.
- **Schedule** — choose the daily run time from inside the app.
- **Run now** — generate today's digest on demand instead of waiting for the scheduled run.

## How it works

A small `fetch.sh` cron job runs daily at the time saved from Settings. It:

1. Loads `system-prompt.md` (baked HTML report contract) and your `topics.txt` editorial brief from app storage and composes them into one system prompt.
2. Reads `agent.json` for the chosen provider + model.
3. Invokes the chosen CLI (Claude or Codex). Claude is allowed WebSearch and WebFetch for cited-page/image research; Codex runs in a read-only sandbox. The service token is never in the agent's prompt; `fetch.sh` holds it and does the storage write itself, so a prompt-injection in a poisoned search result has no token to exfiltrate and no write-capable shell to run.
4. Extracts the `<article class="news-report">` fragment from the agent's reply, sanitizes it server-side (writing-focused tag allowlist, http(s) links only, no scripts/styles/event handlers), and PUTs it to `reports/YYYY-MM-DD.html`. If the agent didn't return usable HTML, a clearly marked HTML error report is written for first-run failures. If a same-day rerun fails after a ready digest already exists, the ready digest is left untouched.
5. Writes `reports/YYYY-MM-DD.meta.json` with `status: "ready"` or `status: "error"` (the STORED report's status) so rerun failures cannot overwrite a known-good digest, and `reports/YYYY-MM-DD.run.json` recording THIS run's lifecycle (`started_at`/`finished_at`/`status`) so the app can detect completion even when the overwrite guard leaves the report untouched.
6. Sends a push notification and appends a `cron_summary` signal for the run.

The app's Reports tab enumerates report files via the storage-listing endpoint, shows a summary feed, and opens each digest as a full-page HTML reader. It picks up out-of-band (cron) writes by relisting on foreground and reconnect and via a modest while-visible poll — NOT via `window.mobius.storage.subscribe`, which only re-notifies on the same tab's own writes and so never fires for a cron job. While a manual "Generate report now" is in flight it polls `reports/YYYY-MM-DD.run.json` to know when the run finished (success or failure) rather than inferring it from the report file's mtime. Older `reports/YYYY-MM-DD.json` digests still render through the legacy React path so history remains readable. The last few reports are cached locally so they still open offline.

## Source Layout

- `index.jsx` — app shell, tabs, online state, dead-letter banner.
- `constants.js` — provider labels, defaults, report CSP, cache versions.
- `domain.js` — pure helpers for schedules, dates, provider lists, report sanitizing, and iframe `srcdoc` generation.
- `storage.js` — Möbius storage wrappers, durable-write classification, report listing/body loading, the generate-poll run-status probe, offline cache, online hook.
- `signals.js` — Reflection signal emitters (`signal`) plus a 60s-window deduped `signalError` so poll-driven error signals don't flood `signals.jsonl`.
- `ui/*.jsx` — Reports, reader, settings, model picker, question cards, and embedded chat.
- `fetch.sh` — cron workhorse that reads app storage, runs the selected CLI, sanitizes output, writes reports, notifications, the meta + run-status sidecars, and `cron_summary`.

## Data Contracts

- `topics.txt` — owner-editable editorial brief, plain text.
- `agent.json` — `{ "provider": "claude" | "codex", "model": "<model-id>" }`.
- `schedule.json` — `{ "hour": 7, "minute": 30, "timezone": "America/New_York", "cron": "30 7 * * *" }`. The app stores the timezone and `fetch.sh` uses it for report dating; current Möbius cron registration still stores the five-field cron as-is.
- `reports/YYYY-MM-DD.html` — sanitized HTML digest or diagnostics report.
- `reports/YYYY-MM-DD.meta.json` — STORED-report status sidecar (`ready`/`error`) used by rerun overwrite protection.
- `reports/YYYY-MM-DD.run.json` — `{ "started_at", "finished_at", "status": "ok"|"error"|"running", "message" }`; per-run lifecycle the generate poll reads to detect completion honestly.
- `question-answers/YYYY-MM-DD.json` — durable answers from in-report question cards.
- `chat_id.json` — app-scoped chat id managed by `window.mobius.chat`.

## License

MIT — see [LICENSE](LICENSE).
