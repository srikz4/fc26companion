/**
 * Learn fixture-slot names from every save already archived.
 *
 *   npm run backfill:fixtures
 *
 * Companion names a slot when a save proves it — from the results round-up, or
 * from who a known club played in the latest round. A single save proves only
 * what its own matchday showed, so a division looks mostly anonymous until a few
 * rounds have gone by.
 *
 * The archive under `snapshots/` already holds every save ingested so far, each
 * carrying its own round. Reading them once, in order, recovers everything those
 * rounds could have told us. Run it after ingesting a backlog; the live server
 * keeps up on its own from then on.
 *
 * Nothing is invented and nothing is overwritten: names already in the store
 * stand, contradictions are counted and dropped, and only the current season is
 * touched, because a new season redraws the fixtures and reshuffles the slots.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave, type Tables } from '../src/parser/dbReader.ts';
import { readFixtureLedger, readLatestResults, type SlotFixture } from '../src/parser/fixtures.ts';
import { anchorSlots, compForLeague, completeByElimination } from '../src/engine/standings.ts';
import { cascadeSlots, pairingsFromLineups, type Pairing } from '../src/engine/pairings.ts';
import { HistoryStore, readCareerIdentity } from '../src/store/store.ts';
import { listManagerCareerSaves, resolveSaveDirectory } from '../src/core/saveLocation.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const store = new HistoryStore(join(root, 'store', 'history.sqlite'));
const meta = loadDbMeta(join(root, 'data', 'fifa_ng_db-meta.xml'));

function allSaves(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...allSaves(p));
    else if (p.endsWith('.bin')) out.push(p);
  }
  return out;
}

function latestPlayedDate(fixtures: SlotFixture[]): number | null {
  let latest: number | null = null;
  for (const f of fixtures) {
    if (f.goalsA === null || f.goalsB === null) continue;
    if (latest === null || f.date > latest) latest = f.date;
  }
  return latest;
}

const num = (row: Record<string, unknown> | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;

function clubOf(tables: Tables): number | null {
  for (const t of ['career_managerinfo', 'career_users'] as const) {
    const v = num((tables[t] ?? [])[0], 'clubteamid');
    if (v !== null) return v;
  }
  return null;
}

const saveDirectory = resolveSaveDirectory();
const live = saveDirectory ? listManagerCareerSaves(saveDirectory)[0]?.path : undefined;
if (!live) {
  console.error('No Manager Career save found — nothing to anchor the archive against.');
  process.exit(1);
}

// The calendar to reason against is the live one: it is this season's draw, and
// an archived save from the same season shares it.
const liveBytes = readFileSync(live);
const liveTables = parseSave(liveBytes, meta).tables;
const fixtures = readFixtureLedger(liveBytes);
if (!fixtures) {
  console.error('The fixture ledger in the current save could not be read.');
  process.exit(1);
}

const season = num((liveTables['career_users'] ?? [])[0], 'seasoncount');
const club = clubOf(liveTables);
const leagueOfTeam = new Map<number, number>();
const leagueClubs = new Map<number, number[]>();
for (const l of liveTables['leagueteamlinks'] ?? []) {
  const t = num(l, 'teamid');
  const lg = num(l, 'leagueid');
  if (t === null || lg === null) continue;
  leagueOfTeam.set(t, lg);
  if (!leagueClubs.has(lg)) leagueClubs.set(lg, []);
  leagueClubs.get(lg)!.push(t);
}
const ourLeague = club === null ? null : (leagueOfTeam.get(club) ?? null);
if (season === null || ourLeague === null) {
  console.error('Could not read the season or the club league from the current save.');
  process.exit(1);
}

const identity = readCareerIdentity(liveTables);
const career =
  store.careers().find((c) => c.managerName === identity.managerName && c.clubName === identity.clubName) ??
  store.careers()[0];
if (!career) {
  console.error('No career in the store yet. Ingest at least one save first.');
  process.exit(1);
}

// `--reset` throws away what was learned and works it out again. The names are
// derivations, not observations, so rebuilding them is always safe -- and it is
// the only way to benefit from a correction to how they are derived.
if (process.argv.includes('--reset')) {
  const cleared = store.forgetFixtureLearning(career.careerId, season);
  console.log(`--reset: cleared ${cleared} remembered row${cleared === 1 ? '' : 's'} for season ${season}.`);
}

const archive = allSaves(join(root, 'snapshots')).sort();
console.log(`season ${season}; ${archive.length} archived save${archive.length === 1 ? '' : 's'} to read.`);

let read = 0;
let otherSeason = 0;
let unreadable = 0;
let namedFromResults = 0;
let pairingsSeen = 0;

const absorb = (bytes: Buffer): void => {
  let tables: Tables;
  try {
    tables = parseSave(bytes, meta).tables;
  } catch {
    unreadable++;
    return;
  }
  if (num((tables['career_users'] ?? [])[0], 'seasoncount') !== season) {
    otherSeason++;
    return;
  }
  read++;

  const results = readLatestResults(bytes, (id) => leagueOfTeam.get(id) ?? null) ?? [];
  namedFromResults += store.recordSlotNames(
    career.careerId,
    season,
    anchorSlots(fixtures, results, { leagueSize: (lg) => leagueClubs.get(lg)?.length ?? null }),
  );

  // Each archived save knows its own round, which is what its lineups describe.
  const own = readFixtureLedger(bytes);
  const round = own ? latestPlayedDate(own) : null;
  if (round === null) return;
  const pairs: Pairing[] = pairingsFromLineups(
    tables['career_playerlastmatchhistory'] ?? [],
    (id) => leagueOfTeam.get(id) ?? null,
    ourLeague,
    leagueClubs.get(ourLeague) ?? [],
  ).map(([teamA, teamB]) => ({ date: round, teamA, teamB }));
  pairingsSeen += store.recordPairings(career.careerId, season, ourLeague, pairs);
};

absorb(liveBytes);
for (const path of archive) {
  try {
    absorb(readFileSync(path));
  } catch {
    unreadable++;
  }
}
console.log(
  `read ${read} save${read === 1 ? '' : 's'} from this season ` +
    `(skipped ${otherSeason} from other seasons, ${unreadable} unreadable).`,
);
console.log(`${namedFromResults} slot name${namedFromResults === 1 ? '' : 's'} from results, ${pairingsSeen} new pairing${pairingsSeen === 1 ? '' : 's'}.`);

// Now let everything learned resolve against everything else.
let anchors = store.slotNames(career.careerId, season);
const comp = compForLeague(anchors, (id) => leagueOfTeam.get(id) ?? null, ourLeague);
if (comp === null) {
  console.log('No round-up has named a club in your league yet, so there is nothing to cascade from.');
  process.exit(0);
}
const grown = cascadeSlots(fixtures, comp, anchors, store.pairings(career.careerId, season, ourLeague));
anchors = completeByElimination(fixtures, comp, grown.anchors, leagueClubs.get(ourLeague) ?? []);
store.recordSlotNames(career.careerId, season, anchors);

const teamNames = new Map<number, string>();
for (const t of liveTables['teams'] ?? []) {
  const id = num(t, 'teamid');
  if (id !== null && typeof t['teamname'] === 'string') teamNames.set(id, t['teamname']);
}
const named = store.slotNames(career.careerId, season).filter((a) => a.comp === comp);
console.log(
  `\ncascade named ${grown.learned} more` +
    `${grown.contradictions ? `, dropped ${grown.contradictions} contradictory pairing(s)` : ''}.`,
);
console.log(`${named.length} of ${leagueClubs.get(ourLeague)?.length ?? '?'} clubs in your division are now named:`);
for (const a of named.sort((x, y) => x.slot - y.slot)) {
  console.log(`  slot ${a.slot}  ${teamNames.get(a.teamId) ?? a.teamId}`);
}
