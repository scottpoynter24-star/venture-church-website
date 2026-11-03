# Your Venture Church website

Static site served by Cloudflare. Every push to `main` redeploys it.

## Daily Church Center sync

`.github/workflows/church-center-sync.yml` runs twice a day. It opens the public
Church Center pages in a headless browser and updates:

- `data/events.json`: the calendar for the next 9 weeks, plus any event on the
  **Registrations** page that the calendar doesn't already show.
- `data/groups.json`: open small groups.

Rules it follows: series ids stay stable, "Men's Prayer Breakfast" is published as
"Men's Breakfast", known rooms are linked (Sunday services → Auditorium, Restore and
GriefShare → Multipurpose Room, and so on), and group locations never include a
host's name or street address. Hand-written summaries, categories and rooms are kept.
New events and groups arrive without a summary; add one by editing the JSON.

If Church Center looks broken (empty calendar, or groups drop by more than half) the
run changes nothing and fails, and GitHub emails the repo owner.

Run it by hand: **Actions → Church Center sync → Run workflow**.
Offline check of the merge rules: `cd sync && npm ci && npm test`.
