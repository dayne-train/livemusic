/* One-time backfill: reconstruct the show archive from git history.
 *
 * Every refresh since launch committed a data/events.json snapshot, so the
 * repo history already contains every show that was ever listed. This walks
 * those snapshots oldest-to-newest and upserts every past-dated event into
 * the per-year archive files (data/archive-YYYY.json). Later snapshots win
 * on id, matching the live pipeline's behavior. Safe to re-run.
 *
 *   cd ingest && node backfill-archive.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upsertArchive } from './merge.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const git = (args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

const shas = git(['rev-list', '--reverse', 'HEAD', '--', 'data/events.json'])
  .trim().split('\n').filter(Boolean);
console.log(`${shas.length} snapshots of data/events.json in history`);

const candidates = new Map();
const venueDict = {};
let parsed = 0;
for (const sha of shas) {
  let json;
  try {
    json = JSON.parse(git(['show', `${sha}:data/events.json`]));
  } catch {
    continue; // early snapshots may predate the JSON format
  }
  parsed++;
  for (const e of json.events || []) {
    if (e.id && e.date && e.date < todayISO) candidates.set(e.id, { ...e, merged_from: undefined });
  }
  Object.assign(venueDict, json.venues || {});
}
console.log(`parsed ${parsed} snapshots, ${candidates.size} past events collected`);

const written = await upsertArchive(candidates, venueDict);
if (written.length === 0) console.log('archive already up to date');
for (const w of written) console.log(`wrote data/archive-${w.year}.json (${w.count} events)`);
