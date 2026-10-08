# Calf Raise Hold Tracker

A simple PWA for logging single-leg calf raise hold times. Tap a leg, hold, tap stop — the duration is saved automatically. After a few days of logging, the Progress tab charts your average hold time per leg so you can see whether you're holding longer over time.

## Features

- One-tap timer per leg (Left / Right), no manual entry needed
- Today's hold count and average per leg
- Full history grouped by day, with delete per entry
- Progress chart of daily average hold time per leg
- Installable PWA, works offline (data stored locally in the browser)

## Local dev

No build step — it's static HTML/CSS/JS. Serve the folder with any static server, e.g.:

```bash
npx serve .
```

Then open the printed local URL in your browser (or on your phone, over the same network, to test as an installed PWA).

## Data

All entries are stored in `localStorage` on the device — nothing is sent anywhere. Clearing browser data or using a different device/browser starts a fresh history.
