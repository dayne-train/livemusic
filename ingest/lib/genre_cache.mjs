import { readFile, writeFile } from 'node:fs/promises';

const CACHE_PATH = new URL('../../data/artist_genres.json', import.meta.url);

/* Schema:
   {
     "updated_at": "...",
     "artists": {
       "Bishop Mayfield": {
         "spotify_id": "...",
         "spotify_name": "...",
         "spotify_genres": ["blues", "soul"],
         "canonical": ["Blues", "Funk / Soul"],
         "fetched_at": "..."
       },
       "Saucy": {
         "spotify_id": null,
         "spotify_genres": [],
         "canonical": [],
         "no_match": true,
         "fetched_at": "..."
       }
     }
   } */

export class GenreCache {
  constructor() {
    this.data = { artists: {} };
    this.loaded = false;
    this.dirty = false;
  }

  async load() {
    if (this.loaded) return;
    try {
      const txt = await readFile(CACHE_PATH, 'utf8');
      this.data = JSON.parse(txt);
      if (!this.data.artists) this.data.artists = {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('genre cache load warning:', err.message);
      this.data = { artists: {} };
    }
    this.loaded = true;
  }

  has(name) { return !!this.data.artists[name]; }

  get(name) { return this.data.artists[name] || null; }

  set(name, value) {
    this.data.artists[name] = value;
    this.dirty = true;
  }

  size() { return Object.keys(this.data.artists).length; }

  async save() {
    if (!this.dirty) return false;
    // sort for stable diffs across runs
    const sorted = {};
    for (const k of Object.keys(this.data.artists).sort((a, b) => a.localeCompare(b))) {
      sorted[k] = this.data.artists[k];
    }
    this.data.artists = sorted;
    this.data.updated_at = new Date().toISOString();
    await writeFile(CACHE_PATH, JSON.stringify(this.data, null, 2) + '\n');
    return true;
  }
}
