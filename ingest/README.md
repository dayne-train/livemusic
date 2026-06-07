# Ingest pipeline

Builds `data/events.json` by running adapters and merging their output.

## Phase 1

One adapter: `musiclist_txt` (reads the volunteer pipe-delimited file).
Merge is a passthrough until a second source lands.

## Run locally

```sh
cd ingest
node merge.mjs              # fetches live musiclist.txt
node merge.mjs --offline    # reads data/musiclist.txt instead
```

Output: `../data/events.json` and `../data/meta.json` updated.

## Schema

```jsonc
{
  "generated_at": "2026-06-06T18:00:00Z",
  "source_timestamp": "06/06/2026 06:55",
  "sources": {
    "musiclist_txt": { "ok": true, "count": 320, "last_ok": "..." }
  },
  "venues": {
    "Belle Fiore Winery": {
      "url": "...", "city": "Ashland", "region": "...",
      "type": "...", "notes": "...", "address": ""
    }
  },
  "events": [
    {
      "id": "<sha1>",
      "date": "2026-06-12",
      "start_raw": "1900",
      "end_raw": "2200",
      "musician": "Bishop Mayfield",
      "genre": "Blues",
      "link": "...",
      "link_name": "",
      "venue": "Belle Fiore Winery",
      "notes": "",
      "event_type": "Band",
      "source": "musiclist_txt",
      "source_url": null
    }
  ]
}
```

## Adding a new adapter

1. Create `adapters/<name>.mjs` exporting `async function ingest(opts) => { ok, count, events, venues, source_timestamp, error }`
2. Import it in `merge.mjs` and add to the `ADAPTERS` list with a `trust` weight
3. Re-run `node merge.mjs`
