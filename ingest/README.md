# Ingest pipeline

Builds `data/events.json` by running adapters and merging their output. Runs every 4 hours via `.github/workflows/refresh-data.yml`.

## Sources

| Adapter | Source | Trust |
|---|---|---|
| `musiclist_txt` | `roguevalleylivemusicnightlife.com/musiclist.txt` (volunteer-maintained pipe-delimited file) | 100 |
| `tribe_ics` | Belle Fiore, Grizzly Peak, Roxy Ann Winery ICS feeds (WordPress + Tribe Events) | 80 |
| `talent_club` | `talentclublive.com/live-music/` HTML scrape | 80 |
| `black_sheep` | `theblacksheep.com/events/` schema.org Event JSON-LD | 80 |

Higher trust wins on dedup overlaps. The volunteer list is the floor.

## Run locally

```sh
cd ingest
node merge.mjs              # fetches all live sources
node merge.mjs --offline    # reads data/musiclist.txt only, skips network sources
```

Output: `../data/events.json` and `../data/meta.json` updated.

## Schema

```jsonc
{
  "generated_at": "2026-06-06T18:00:00Z",
  "source_timestamp": "06/06/2026 06:55",
  "content_hash": "d22845d490468272",
  "sources": {
    "musiclist_txt": { "ok": true, "count": 324, "strategy": "live", "last_ok": "...", "last_attempt": "...", "error": null },
    "tribe_ics":     { "ok": true, "count": 22, "strategy": "live", "..." },
    "talent_club":   { "ok": true, "count": 7,  "strategy": "live", "..." }
  },
  "venues": {
    "Belle Fiore": {
      "url": "...", "city": "Ashland", "region": "Ashland",
      "type": "Winery", "notes": "", "address": "",
      "_sources": ["musiclist_txt", "tribe_ics"]
    }
  },
  "events": [
    {
      "id": "<sha1>",
      "date": "2026-06-12",
      "start_raw": "1900",
      "end_raw": "2200",
      "end_estimated": false,
      "musician": "Bishop Mayfield",
      "genre": "Blues",
      "genres": ["Blues"],
      "link": "...",
      "link_name": "",
      "venue": "Belle Fiore",
      "notes": "",
      "event_type": "Band",
      "source": "musiclist_txt",
      "source_url": null
    }
  ]
}
```

- `content_hash` is a stable SHA over events + venues (excluding timestamps) so the workflow can skip commits when only the timestamp moved.
- `end_estimated: true` means the source didn't publish an end time and the adapter synthesized one (Talent Club uses start + 2h). The UI shows a small (i) tooltip on these.
- `genres` is the canonical multi-bucket array used for filtering. `genre` is the raw display string from the upstream source.

## Adding a new adapter

1. Create `adapters/<name>.mjs` exporting `async function ingest(opts) => { ok, count, events, venues, source_timestamp, error, strategy, fetched_at }`
2. Import it in `merge.mjs` and add to the `ADAPTERS` list with a `trust` weight
3. Re-run `node merge.mjs`

## Dedup logic

Events are grouped by `(normalized_venue_key, date)`. Within a group, two events match if they share an artist key OR have token-Jaccard overlap >= 0.6 on artist names AND start times within 90 minutes. Trust-ordered: the winner's display fields stay, blank fields get backfilled from the loser, and the losing entry is dropped (logged in `meta.json` as `deduped`).

## Genre buckets

`lib/genres.mjs` maps messy raw genre text to a small canonical set (Rock, Blues, Folk, Country, Bluegrass, Swing, Jazz, Latin, Funk / Soul, Reggae, Pop, etc.). The merge step probes each event's explicit genre, the volunteer dictionary lookup by musician name, the musician name itself, and the event notes -- then unions canonical buckets and caps at 3 per event.
