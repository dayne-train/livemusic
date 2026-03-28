# Rogue Live

Live music listings for the Rogue Valley — Medford, Ashland, Grants Pass, and surrounding areas in Southern Oregon.

**Live site:** [dayne-train.github.io/livemusic](https://dayne-train.github.io/livemusic/)

## What it does

Rogue Live pulls live music event data from [roguevalleylivemusicnightlife.com](https://roguevalleylivemusicnightlife.com/) and presents it in a fast, filterable interface. It's a single HTML file with no build step and no dependencies.

### Features

- **Date filtering** — Today, Tomorrow, Weekend, This week, Next 7 days, This month, or custom date range
- **Region filtering** — Medford, Ashland, Grants Pass, Rogue River
- **Type / Genre / Venue type filters** — dropdown pills on desktop, bottom sheet on mobile
- **Search** — filter by artist, venue, or city
- **Card & Row views** — toggle between grid cards and compact table rows
- **Event details modal** — venue, time, notes, links, directions
- **Add to Calendar** — `.ics` download for any show
- **Share** — deep-linkable URLs for any show or filtered view
- **Offline-capable** — caches data in localStorage, shows stale data if the source is down
- **3 CORS proxy fallbacks** — cascading proxy chain with 8s timeouts
- **Responsive** — mobile-first with bottom sheet filters, always-visible card actions
- **Accessible** — skip link, focus trapping, ARIA roles, keyboard navigation, WCAG AA contrast, reduced motion support

## Tech

Single `index.html` file. No framework, no build tools, no npm.

- Vanilla HTML/CSS/JS
- CSS custom properties for theming
- Hosted on GitHub Pages

## Data source

Event data is fetched at runtime from `roguevalleylivemusicnightlife.com/musiclist.txt` — a pipe-delimited text file maintained by local volunteers. The site uses CORS proxies (allorigins, codetabs, corsproxy.io) since the source doesn't serve CORS headers.

## Running locally

Just open `index.html` in a browser. No server needed.

## Contact

Made with love in Medford — [hello@dayne.design](mailto:hello@dayne.design)
