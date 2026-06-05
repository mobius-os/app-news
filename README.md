# News

A daily AI-curated news digest for [Möbius](https://github.com/mobius-os). Each morning a Claude (or Codex) sub-agent searches the web for top stories across world, business, tech, science, sports, and culture, then drops a readable HTML digest into the app for you to read.

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
- **Agent / Model** — which connected provider + model generates the digest (Claude Code or OpenAI Codex), using the same visible model list as chat.
- **Schedule** — choose the daily run time from inside the app.
- **Run now** — generate today's digest on demand instead of waiting for the scheduled run.

## How it works

A small `fetch.sh` cron job runs daily at the time saved from Settings. It:

1. Loads `system-prompt.md` (baked HTML report contract) and your `topics.txt` editorial brief from app storage and composes them into one system prompt.
2. Reads `agent.json` for the chosen provider + model.
3. Invokes the chosen CLI (Claude or Codex) with **WebSearch as the only allowed tool** — no Bash, no Write, no WebFetch. The service token is never in the agent's prompt; `fetch.sh` holds it and does the storage write itself, so a prompt-injection in a poisoned search result has no token to exfiltrate and no shell to run.
4. Extracts the `<article class="news-report">` fragment from the agent's reply, sanitizes it server-side (writing-focused tag allowlist, http(s) links only, no scripts/styles/event handlers), and PUTs it to `reports/YYYY-MM-DD.html`. If the agent didn't return usable HTML, a clearly marked HTML error report is written so the date still shows up with an honest "could not be generated" note.
5. Sends a push notification when the digest is ready.

The app's Reports tab enumerates report files via the storage-listing endpoint, shows a summary feed, and opens each digest as a full-page HTML reader. Older `reports/YYYY-MM-DD.json` digests still render through the legacy React path so history remains readable. The last few reports are cached locally so they still open offline.

## License

MIT — see [LICENSE](LICENSE).
