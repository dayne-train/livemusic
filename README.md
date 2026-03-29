# Rogue Valley Live Music

Live music listings for the Rogue Valley -- Medford, Ashland, Grants Pass, and surrounding areas in Southern Oregon.

**Live site:** [rvlivemusic.com](https://rvlivemusic.com/)

## Features

- **Date filtering** -- Today, Tomorrow, Weekend, This week, Next 7 days, This month, or custom date range
- **Region filtering** -- Medford, Ashland, Grants Pass, Rogue River
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

Single `index.html` file. No framework, no build tools, no dependencies.

- Vanilla HTML/CSS/JS
- CSS custom properties for theming
- Hosted on GitHub Pages with custom domain

## Data source

Event data is fetched at runtime from `roguevalleylivemusicnightlife.com/musiclist.txt`, a pipe-delimited text file maintained by local volunteers. The site uses CORS proxies (allorigins, codetabs) since the source does not serve CORS headers.

## Running locally

Open `index.html` in a browser. No server needed.

## Contact

- General: [roguevalleylivemusic@gmail.com](mailto:roguevalleylivemusic@gmail.com)
- Site: [hello@dayne.design](mailto:hello@dayne.design)
