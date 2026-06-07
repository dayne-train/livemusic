/* Spotify catalog lookups via client-credentials flow.
   Used to enrich genres for artists not covered by the volunteer list's
   musicians dictionary. Read-only, no user data. */

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';

const SKIP_PATTERNS = [
  /^Live Music$/i,
  /^Music$/i,
  /^Open Mic/i,
  /^Open Jam/i,
  /Jam Session$/i,
  /Karaoke/i,
  /^Unknown$/i,
  /^TBD$/i,
  /^Sing.?Along/i,
  /^Mic Night$/i,
  /^Live$/i,
];

export function isGenericArtistName(name) {
  if (!name || typeof name !== 'string') return true;
  const t = name.trim();
  if (t.length < 3) return true;
  return SKIP_PATTERNS.some(re => re.test(t));
}

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickExactMatch(query, items) {
  const target = normalizeName(query);
  for (const it of items || []) {
    if (normalizeName(it.name) === target) return it;
  }
  return null;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export class Spotify {
  constructor({ clientId, clientSecret }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.tokenExpiry = 0;
  }

  static fromEnv() {
    const id = process.env.SPOTIFY_CLIENT_ID;
    const secret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!id || !secret) return null;
    return new Spotify({ clientId: id, clientSecret: secret });
  }

  async _getToken() {
    if (this.token && Date.now() < this.tokenExpiry - 30000) return this.token;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Spotify token fetch failed: ${res.status}`);
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    return this.token;
  }

  /* Returns { spotify_id, name, genres } on exact-match, or null if no match
     or only fuzzy matches found. Throws on hard errors so caller can decide
     whether to abort or continue. */
  async lookupArtist(query) {
    if (isGenericArtistName(query)) return null;
    const token = await this._getToken();
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&type=artist&limit=5`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('Retry-After') || '1', 10);
      await sleep(Math.min(retry, 10) * 1000);
      return this.lookupArtist(query);
    }
    if (res.status === 401) {
      // token expired mid-run; clear and retry once
      this.token = null;
      return this.lookupArtist(query);
    }
    if (!res.ok) throw new Error(`Spotify search failed: ${res.status}`);
    const data = await res.json();
    const match = pickExactMatch(query, data?.artists?.items);
    if (!match) return null;
    return {
      spotify_id: match.id,
      name: match.name,
      genres: Array.isArray(match.genres) ? match.genres : [],
    };
  }
}
