# News

A daily AI-curated news digest for [Möbius](https://github.com/mobius-os). Each morning a Claude (or Codex) sub-agent searches the web for top stories across world, business, tech, science, sports, and culture, then drops a structured digest into the app for you to read.

![News app screenshot](docs/screenshot.png)
<!-- TODO: add docs/screenshot.png after first install. -->
<!-- TODO: icon.png — currently relying on Möbius's auto-generated letter icon. -->

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
- **Agent / Model** — which connected provider + model generates the digest (Claude Code or OpenAI Codex).
- **Run now** — generate today's digest on demand instead of waiting for the scheduled run.

### Changing when it runs

The digest runs **once a day at 10:00 UTC** (the schedule registered at install). There is no in-app time picker: the platform has no reconciler that would act on a saved time, so offering one would be dishonest. To change the time, ask the Möbius agent — e.g. "reschedule the News digest to 7am my time" — and it edits the cron entry directly. (A platform-side schedule reconciler that reads `schedule.json` and re-syncs the crontab is tracked but not yet built; once it lands, an in-app picker can return.)

## How it works

A small `fetch.sh` cron job runs daily at 10:00 UTC. It:

1. Loads `system-prompt.md` (baked JSON schema) and your `topics.txt` editorial brief from app storage and composes them into one system prompt.
2. Reads `agent.json` for the chosen provider + model.
3. Invokes the chosen CLI (Claude or Codex) with **WebSearch as the only allowed tool** — no Bash, no Write, no WebFetch. The service token is never in the agent's prompt; `fetch.sh` holds it and does the storage write itself, so a prompt-injection in a poisoned search result has no token to exfiltrate and no shell to run.
4. Parses the JSON report object from the agent's reply, normalizes it (drops fabricated/non-http source URLs and incomplete articles), and PUTs it as a bare object to `reports/YYYY-MM-DD.json`. If the agent didn't return a usable object, a short stub is written so the date still shows up with an honest "could not be generated" note.
5. Sends a push notification when the digest is ready.

The app's Reports tab enumerates report files via the storage-listing endpoint and renders each as a tap-to-expand card through React with the Möbius theme tokens. Because reports are structured JSON (no agent-authored HTML, no `dangerouslySetInnerHTML`), there's nothing to sanitize — the only untrusted string is each article's `source_url`, which is gated to `http(s)` before it becomes a link. The last few reports are cached locally so they still open offline.

## License

MIT — see [LICENSE](LICENSE).
