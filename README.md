# Calf Raise Hold Tracker

A simple PWA for logging single-leg calf raise hold times. Tap a leg, hold, tap stop — the duration is saved automatically. After a few days of logging, the Progress tab charts your average hold time per leg so you can see whether you're holding longer over time.

## Features

- 3 sessions a day, 3 holds per leg per session; enter times manually or use the helper stopwatch
- Automatic encrypted backup to NOSTR
- Today's hold count and average per leg
- Full history grouped by day, with delete per entry
- Progress chart of daily average hold time per leg
- Installable PWA, works offline (data stored locally in the browser)

## Backup (NOSTR)

Each hold is encrypted (NIP-44, to your own key) and published to NOSTR relays as soon as you save it; deletes are published too. On every launch the app pulls the backup, merges anything missing, and pushes anything the relays don't have yet.

- The key is generated on first launch and kept in localStorage. **Copy it from the Backup tab and store it somewhere safe** - it's the only way to restore.
- To restore on a new device/browser: Backup tab -> paste the key -> Import & sync.

## Local dev

```bash
npm install
npm run dev
```

## Build / deploy

`npm run build` outputs to `dist/`. Push to GitHub - Vercel builds and deploys on every push to `main` (see `vercel.json`).

## Data

Holds live in `localStorage` on the device and in your encrypted NOSTR backup.
