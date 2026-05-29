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

Everything is editable from the **Settings** tab inside the app:

- **Delivery time** — the daily cron time (UTC, with your local equivalent shown alongside). Defaults to 10:00 UTC.
- **Categories** — toggle world, business, tech, science, sports, culture on or off.
- **Curator prompt** — the full system prompt sent to the AI each day. Edit to focus on specific beats, change tone, or restructure the output. A **Reset to default** button is one click away.

Schedule changes take effect within 10 minutes (the cron sync runs every 10).

## How it works

A small `fetch.sh` cron job runs at your chosen time. It:

1. Loads your latest `prompt.md` from app storage
2. Invokes the Claude CLI (falling back to Codex) with web access
3. Parses the agent's JSON output
4. Saves it to `reports/YYYY-MM-DD.json` in app storage
5. Sends a push notification when the digest is ready

The app's Reports tab scans the last 30 days of report files and renders them as expandable cards.

## License

MIT — see [LICENSE](LICENSE).
