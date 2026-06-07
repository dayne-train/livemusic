# Rogue Valley Live Music

Live music listings for the Rogue Valley -- Medford, Ashland, Grants Pass, and surrounding areas in Southern Oregon.

**Live site:** [rvlivemusic.com](https://rvlivemusic.com/)

## Features

- **Date filtering** -- Today, Tomorrow, Weekend, This week, Next 7 days, This month, or custom date range
- **Region filtering** -- Medford, Ashland, Grants Pass, Rogue River
- **Time of day filter** -- Daytime, Evening, Late night
- **Type / Genre / Venue type filters** -- dropdown pills on desktop, bottom sheet on mobile
- **Search** -- filter by artist, venue, or city
- **Card and Row views** -- toggle between grid cards and compact table rows
- **Event details modal** -- venue, time, notes, links, directions
- **Add to Calendar** -- .ics download for any show
- **Share** -- deep-linkable URLs for any show or filtered view
- **Offline-capable** -- caches data in localStorage, shows stale data if the source is down
- **Dark/light theme** -- toggleable with system preference detection
- **Responsive** -- mobile-first with bottom sheet filters, always-visible card actions
- **Accessible** -- skip link, focus trapping, ARIA roles, keyboard navigation, reduced motion support

## Tech

Single `index.html` file for the site itself -- no framework, no build tools, no runtime dependencies. The ingest pipeline is a small Node script that prepares the data.

- Vanilla HTML/CSS/JS
- CSS custom properties for theming
- Hosted on GitHub Pages with custom domain
- Node-based ingest pipeline under `ingest/` (see `ingest/README.md`)

## Data sources

Event data is built into `data/events.json` by a pipeline that pulls from multiple sources every few hours:

- `roguevalleylivemusicnightlife.com/musiclist.txt` -- pipe-delimited volunteer-maintained list, the backbone of the listings
- Belle Fiore, Grizzly Peak, and Roxy Ann Winery -- their own published WordPress / Tribe Events calendar feeds
- The Talent Club -- scraped from `talentclublive.com/live-music/`

The pipeline trust-orders the sources, de-duplicates shows that appear in more than one feed (volunteer list wins on overlaps), and writes the result to a same-origin `data/events.json`. The site reads that JSON directly with no proxies. If `events.json` is unavailable for any reason, the site falls back to the old proxy + `musiclist.txt` snapshot path.

Refresh runs every 4 hours via a GitHub Action (`.github/workflows/refresh-data.yml`). Commits only land when the actual event content changes.

## Running locally

Open `index.html` in a browser. No server needed.

To re-run the ingest pipeline locally:

```sh
cd ingest
node merge.mjs              # fetches live sources
node merge.mjs --offline    # uses the local musiclist.txt snapshot only
```

## Contact

- General: [roguevalleylivemusic@gmail.com](mailto:roguevalleylivemusic@gmail.com)
- Site: [hello@dayne.design](mailto:hello@dayne.design)
