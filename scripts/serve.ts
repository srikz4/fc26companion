/**
 * The whole app in one process: watch, parse, store, serve.
 *
 *   npm run serve                # http://127.0.0.1:4126
 *   npm run serve -- --port 5000
 *
 * Stop `npm run watch` first — this runs the watcher itself, and two of them
 * writing the same store is pointless (harmless, since ingest is idempotent, but
 * pointless).
 */
import { basename, dirname, join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave, type Tables } from '../src/parser/dbReader.ts';
import { readShortlist } from '../src/parser/careerBlob.ts';
import { readFixtureLedger, readLatestResults } from '../src/parser/fixtures.ts';
import { anchorSlots, compForLeague, completeByElimination } from '../src/engine/standings.ts';
import { cascadeSlots, pairingsFromLineups } from '../src/engine/pairings.ts';
import type { SlotFixture } from '../src/parser/fixtures.ts';
import { HistoryStore, PARSER_VERSION, readCareerIdentity } from '../src/store/store.ts';
import { SaveWatcher } from '../src/watcher/watcher.ts';
import { listManagerCareerSaves, resolveSaveDirectory } from '../src/core/saveLocation.ts';
import { readSaveChoice, rejectSavePath, writeSaveChoice, type SaveCandidate } from '../src/core/saveChoice.ts';
import { createNameResolver, loadNameTable } from '../src/names/nameTable.ts';
import { deriveNameIds } from '../src/names/deriveNameTable.ts';
import { buildViewDocument, type ViewDocument } from '../src/engine/viewModel.ts';
import { deriveStoryEvents } from '../src/engine/story.ts';
import { ViewServer } from '../src/server/server.ts';
import { loadNations } from '../src/domain/nations.ts';
import { readFileSync as readFs, existsSync as existsFs } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const META_PATH = join(root, 'data', 'fifa_ng_db-meta.xml');
const NAMES_PATH = join(root, 'data', 'playernames_fc26.csv');
const NATIONS_PATH = join(root, 'data', 'nations_fc26.csv');
const STORE_PATH = join(root, 'store', 'history.sqlite');
const SAVE_CHOICE_PATH = join(root, 'store', 'save-choice.json');
const SNAPSHOT_DIR = join(root, 'snapshots');
const WEB_ROOT = join(root, 'web');

/**
 * `--lan` is the explicit opt-in the non-negotiables call for (spec.md §3):
 * without it the server binds loopback and no other device can reach it.
 * With it, any phone on your own network can open the printed address.
 */
const wantLan = process.argv.includes('--lan');

/**
 * Addresses a phone could actually reach, best first.
 *
 * A developer machine is full of IPv4 addresses that are useless here — WSL,
 * Hyper-V, Docker and VPN adapters all hand out private ranges, and this box
 * offers 172.24.240.1 before its real Wi-Fi. Printing them in whatever order
 * the OS returns is survivable when a human reads the list and picks; it is not
 * survivable when the first one becomes a QR code. So they are ranked: real
 * adapters over virtual ones, and home ranges over the ranges virtualisation
 * tends to claim.
 */
function lanAddresses(): string[] {
  const VIRTUAL = /vethernet|hyper-?v|wsl|docker|virtualbox|vmware|tailscale|zerotier|loopback|tap-|npcap/i;
  const scored: { address: string; score: number }[] = [];

  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue;
      let score = 0;
      if (VIRTUAL.test(name)) score -= 100;
      if (/wi-?fi|wireless|wlan/i.test(name)) score += 12;
      else if (/ethernet/i.test(name)) score += 10;
      // 192.168/16 is what home routers hand out; 172.16/12 is where the
      // virtual adapters live, so it goes last.
      if (nic.address.startsWith('192.168.')) score += 6;
      else if (nic.address.startsWith('10.')) score += 4;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(nic.address)) score -= 6;
      scored.push({ address: nic.address, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return scored.map((s) => s.address);
}

/** The matchday a save was written after: its latest played fixture. */
function latestPlayedDate(fixtures: SlotFixture[]): number | null {
  let latest: number | null = null;
  for (const f of fixtures) {
    if (f.goalsA === null || f.goalsB === null) continue;
    if (latest === null || f.date > latest) latest = f.date;
  }
  return latest;
}

function argPort(): number {
  const i = process.argv.indexOf('--port');
  const value = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : 4126;
}

async function main(): Promise<void> {
  const saveDirectory = resolveSaveDirectory();
  if (!saveDirectory) {
    console.error('No FC 26 settings directory found. Is the game installed for this user?');
    process.exit(1);
  }

  const meta = loadDbMeta(META_PATH);
  const names = loadNameTable(NAMES_PATH);
  const nations = loadNations(NATIONS_PATH);
  const competitions = new Map<string, string>();
  const compPath = join(root, 'data', 'competitions.csv');
  if (existsFs(compPath)) {
    for (const line of readFs(compPath, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('code,')) continue;
      const comma = line.indexOf(',');
      if (comma > 0) competitions.set(line.slice(0, comma), line.slice(comma + 1).trim());
    }
  }
  const store = new HistoryStore(STORE_PATH);

  let view: ViewDocument | null = null;
  let activeCareerId: number | undefined;
  let rebuilding = false;
  // What the academy and the ratings looked like last time we rebuilt, so a
  // promotion or a milestone can be seen as a change rather than a state.
  let previousAcademyIds: Set<number> | undefined;
  let previousOverall: Map<number, number> | undefined;
  const startedAt = Date.now();
  let lastReadAt: number | null = null;
  let lastReadMs: number | null = null;

  /** Reparse the newest save and rebuild the document the page reads. */
  const rebuild = (): void => {
    if (rebuilding) return;
    rebuilding = true;
    const began = Date.now();
    try {
      const found = listManagerCareerSaves(saveDirectory);
      /**
       * A chosen file wins over the newest one.
       *
       * It goes at the head of the list rather than replacing it, because the
       * others are still useful: the name table is built by comparing saves, and
       * more of them makes it better.
       */
      const chosen = readSaveChoice(SAVE_CHOICE_PATH);
      const present =
        chosen.path === null
          ? found
          : [
              { path: chosen.path, fileName: basename(chosen.path) },
              ...found.filter((f) => f.path !== chosen.path),
            ];
      const latest = present[0];
      if (!latest) {
        console.log('no save yet \u2014 waiting for the game to write one.');
        return;
      }

      /**
       * The game renames its save on every write, so a file listed a moment ago
       * can be gone by the time we open it. That is normal, not an error: skip
       * what has vanished and read what is there.
       */
      const readable: { path: string; bytes: Buffer }[] = [];
      for (const f of present) {
        try {
          readable.push({ path: f.path, bytes: readFileSync(f.path) });
        } catch {
          /* written over while we were looking at it */
        }
      }
      if (!readable.length) {
        console.log('the save moved while it was being read — waiting for the next one.');
        return;
      }
      const bytesAll = readable.map((r) => r.bytes);
      const parsedAll: Tables[] = bytesAll.map((b) => parseSave(b, meta).tables);
      const tables = parsedAll[0]!;
      // The in-game shortlist lives in the tagged career blob after the
      // databases, not in a table — read it from the newest save's raw bytes.
      const playerIds = new Set(
        (tables['players'] ?? []).map((p) => p['playerid']).filter((v): v is number => typeof v === 'number'),
      );
      const shortlist = readShortlist(bytesAll[0]!, (id) => playerIds.has(id));

      // The fixture ledger: the save's own record of what has been played.
      // `leagueteamlinks` does not keep the user's league table live; this does.
      const leagueOfTeam = new Map<number, number>();
      const leagueClubs = new Map<number, number[]>();
      for (const l of tables['leagueteamlinks'] ?? []) {
        const t = l['teamid'];
        const lg = l['leagueid'];
        if (typeof t !== 'number' || typeof lg !== 'number') continue;
        leagueOfTeam.set(t, lg);
        if (!leagueClubs.has(lg)) leagueClubs.set(lg, []);
        leagueClubs.get(lg)!.push(t);
      }
      const clubsInLeague = (lg: number): number[] => leagueClubs.get(lg) ?? [];
      const leagueSize = (lg: number): number | null => leagueClubs.get(lg)?.length ?? null;
      const clubTeamId = (() => {
        for (const t of ['career_managerinfo', 'career_users'] as const) {
          const v = (tables[t] ?? [])[0]?.['clubteamid'];
          if (typeof v === 'number') return v;
        }
        return null;
      })();
      const fixtures = readFixtureLedger(bytesAll[0]!);
      const roundResults = fixtures
        ? (readLatestResults(bytesAll[0]!, (id) => leagueOfTeam.get(id) ?? null, (id) => playerIds.has(id)) ?? [])
        : [];
      const resolver = createNameResolver(tables, names, deriveNameIds(parsedAll, names));

      // Match the store's career to the save we are rendering, so history and
      // watchlist belong to the same save lineage.
      const identity = readCareerIdentity(tables);
      const career =
        store.careers().find((c) => c.managerName === identity.managerName && c.clubName === identity.clubName) ??
        store.careers()[0];
      activeCareerId = career?.careerId;

      /**
       * Which club sits in which fixture slot.
       *
       * Two sources, both read from the save. The results round-up names a few
       * slots outright, when it covers your league at all. The lineup table says
       * who played whom in the latest round, which — against the calendar —
       * names whoever an already-named club just faced. Both accumulate in the
       * store, so a division that starts anonymous fills in as you play.
       */
      // Slots are reshuffled when a season regenerates the fixture list, so what
      // we learned last season must not be applied to this one.
      const seasonCount = (tables['career_users'] ?? [])[0]?.['seasoncount'];
      const season = typeof seasonCount === 'number' ? seasonCount : null;
      const ourLeague = clubTeamId === null ? null : (leagueOfTeam.get(clubTeamId) ?? null);
      let anchors = fixtures ? anchorSlots(fixtures, roundResults, { leagueSize }) : [];

      if (fixtures && activeCareerId !== undefined && season !== null) {
        store.recordSlotNames(activeCareerId, season, anchors);
        if (ourLeague !== null) {
          const round = latestPlayedDate(fixtures);
          if (round !== null) {
            store.recordPairings(
              activeCareerId,
              season,
              ourLeague,
              pairingsFromLineups(
                tables['career_playerlastmatchhistory'] ?? [],
                (id) => leagueOfTeam.get(id) ?? null,
                ourLeague,
                clubsInLeague(ourLeague),
              ).map(([teamA, teamB]) => ({ date: round, teamA, teamB })),
            );
          }
        }
        anchors = store.slotNames(activeCareerId, season);

        // Everything the stored pairings can still resolve.
        if (ourLeague !== null) {
          const comp = compForLeague(anchors, (id) => leagueOfTeam.get(id) ?? null, ourLeague);
          if (comp !== null) {
            const grown = cascadeSlots(fixtures, comp, anchors, store.pairings(activeCareerId, season, ourLeague));
            if (grown.contradictions) {
              console.log(`slots ${grown.contradictions} pairing(s) disagreed with a known club and were dropped`);
            }
            anchors = completeByElimination(fixtures, comp, grown.anchors, clubsInLeague(ourLeague));
            store.recordSlotNames(activeCareerId, season, anchors);
            anchors = store.slotNames(activeCareerId, season);
          }
        }
      }

      view = buildViewDocument({
        tables,
        resolver,
        store,
        careerId: activeCareerId,
        nameTableSize: names.byPlayerId.size,
        nations,
        competitions,
        shortlist,
        ledger: fixtures ? { fixtures, results: roundResults, anchors } : null,
      });

      // The ledger, written once per thing that happened.
      if (activeCareerId !== undefined) {
        const snapshotId = store.latestSnapshot(activeCareerId);
        if (snapshotId !== null) {
          const seniorIds = new Set(view.senior.map((p) => p.playerId));
          const academyIds = new Set(view.academy.map((p) => p.playerId));
          const overallById = new Map<number, number>();
          for (const p of [...view.senior, ...view.academy]) {
            if (p.overall !== null) overallById.set(p.playerId, p.overall);
          }
          const teamNameOf = (id: number): string | null => {
            const row = (tables['teams'] ?? []).find((t) => t['teamid'] === id);
            const nm = row?.['teamname'];
            return typeof nm === 'string' ? nm : null;
          };
          const derived = deriveStoryEvents({
              tables,
              careerId: activeCareerId,
              snapshotId,
              gameDate: view.gameDate,
              season: view.season,
              nameOf: (id) => resolver.resolve(id).display,
              teamNameOf,
              competitionOf: (code) => competitions.get(code) ?? null,
              seniorIds,
              academyIds,
              overallOf: (id) => overallById.get(id) ?? null,
              previousAcademyIds,
              previousOverall,
          });
          const written = store.recordStory(derived);
          // Dates never move; classification is allowed to be corrected.
          const fixed = store.reclassifyStory(derived);
          if (written) console.log(`story ${written} new event${written === 1 ? '' : 's'} recorded`);
          if (fixed) console.log(`story ${fixed} event${fixed === 1 ? '' : 's'} reclassified`);
          previousAcademyIds = academyIds;
          previousOverall = overallById;
          // Rebuild so the page sees the events we just wrote.
          if (written || fixed) {
            view = buildViewDocument({
              tables,
              resolver,
              store,
              careerId: activeCareerId,
              nameTableSize: names.byPlayerId.size,
              nations,
              competitions,
              shortlist,
              ledger: fixtures ? { fixtures, results: roundResults, anchors } : null,
            });
          }
        }
      }

      console.log(
        `view  ${view.club.name ?? '?'} · ${view.senior.length} senior, ${view.academy.length} academy · ` +
          `${view.alerts.length} alerts · ${view.transfers.targets.length} targets · ` +
          `${view.synergy.partnerships.length} partnerships · fit MAE ${view.matchday.calibration.meanAbsoluteError ?? '?'}`,
      );
    } finally {
      rebuilding = false;
      // So the session panel can say when a save was last read, and how long
      // reading it took.
      lastReadAt = Date.now();
      lastReadMs = lastReadAt - began;
    }
  };

  const server = new ViewServer({
    port: argPort(),
    host: wantLan ? '0.0.0.0' : '127.0.0.1',
    webRoot: WEB_ROOT,
    facesRoot: join(root, 'data', 'faces'),
    provider: { get: () => view ?? { error: 'no save parsed yet' } },
    /**
     * What this run is: where to reach it, what it is reading, what it has
     * stored. Gathered on request rather than cached, so the uptime and the
     * "last read" are true at the moment you look.
     */
    session: () => {
      const choice = readSaveChoice(SAVE_CHOICE_PATH);
      const port = argPort();
      const following = choice.path ?? listManagerCareerSaves(saveDirectory)[0]?.path ?? null;
      let savedAt: string | null = null;
      let savedBytes: number | null = null;
      if (following) {
        try {
          const st = statSync(following);
          savedAt = st.mtime.toISOString();
          savedBytes = st.size;
        } catch {
          /* moved while we looked */
        }
      }
      return {
        local: `http://127.0.0.1:${port}`,
        lan: wantLan ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [],
        lanEnabled: wantLan,
        port,
        startedAt: new Date(startedAt).toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        node: process.version,
        parserVersion: PARSER_VERSION,
        watching: choice.path ? dirname(choice.path) : saveDirectory,
        following,
        savedAt,
        savedBytes,
        lastReadAt: lastReadAt === null ? null : new Date(lastReadAt).toISOString(),
        lastReadMs,
        snapshots: store.snapshotCount(),
        careers: store.careers().length,
      };
    },
    saves: {
      list: () => {
        const chosen = readSaveChoice(SAVE_CHOICE_PATH);
        const seen = new Map<string, SaveCandidate>();
        const add = (path: string, name: string): void => {
          if (seen.has(path)) return;
          try {
            const st = statSync(path);
            seen.set(path, {
              path,
              name,
              sizeBytes: st.size,
              modified: st.mtime.toISOString(),
              active: chosen.path === null ? seen.size === 0 : path === chosen.path,
            });
          } catch {
            /* a file that vanished is simply not offered */
          }
        };
        if (chosen.path) add(chosen.path, basename(chosen.path));
        for (const f of listManagerCareerSaves(saveDirectory)) add(f.path, f.fileName);
        return {
          following: chosen.path === null ? 'newest' : 'chosen',
          chosenPath: chosen.path,
          chosenAt: chosen.chosenAt,
          watching: chosen.path ? dirname(chosen.path) : saveDirectory,
          saveDirectory,
          candidates: [...seen.values()],
        };
      },
      choose: (path) => {
        if (path !== null) {
          const problem = rejectSavePath(path);
          if (problem) return problem;
        }
        writeSaveChoice(SAVE_CHOICE_PATH, path);
        retarget();
        return null;
      },
    },
  });

  /** Point the watcher at whichever folder holds the file we are reading. */
  const startingChoice = readSaveChoice(SAVE_CHOICE_PATH);
  let watcher = new SaveWatcher({
    saveDirectory: startingChoice.path === null ? saveDirectory : dirname(startingChoice.path),
    snapshotDirectory: SNAPSHOT_DIR,
    meta,
    store,
  });

  const listen = (w: SaveWatcher): void => {
    w.on('processed', (event) => {
      console.log(
        `+ ${event.file}  snapshot ${event.result.snapshotId}: ` +
          `${event.result.entities} players, ${event.result.observations.toLocaleString('en-GB')} observations`,
      );
      rebuild();
      server.broadcast('refresh', { file: event.file, at: new Date().toISOString() });
    });
    w.on('error', (error, file) => console.error(`! ${file}: ${error.message}`));
  };
  listen(watcher);

  /**
   * Follow a newly chosen file.
   *
   * The old watcher is stopped before the new one starts, so only one folder is
   * ever being watched and a save written in either place cannot be ingested
   * twice at once.
   */
  function retarget(): void {
    const choice = readSaveChoice(SAVE_CHOICE_PATH);
    // `saveDirectory` is proved non-null above, but a nested function declaration
    // does not carry that narrowing with it.
    const folder = choice.path === null ? (saveDirectory as string) : dirname(choice.path);
    watcher.stop();
    watcher = new SaveWatcher({ saveDirectory: folder, snapshotDirectory: SNAPSHOT_DIR, meta, store });
    listen(watcher);
    void watcher
      .ingestAll()
      .then(() => {
        rebuild();
        server.broadcast('refresh', { file: choice.path ?? 'newest', at: new Date().toISOString() });
      })
      .catch((error: unknown) => console.error(`! could not read ${folder}: ${(error as Error).message}`));
    watcher.start();
    console.log(`watching ${folder}${choice.path ? ` (following ${basename(choice.path)})` : ''}`);
  }

  // Catch up on anything already on disk, then open the door.
  await watcher.ingestAll();
  rebuild();

  let url: string;
  try {
    url = await server.listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(
        `Port ${argPort()} is already in use — Companion is probably running in another window. ` +
          'Close it, or start this one with: npm run serve -- --port 4127',
      );
      process.exit(1);
    }
    throw error;
  }
  watcher.start();

  console.log(`\n  Companion is at  ${wantLan ? `http://127.0.0.1:${argPort()}` : url}`);
  if (wantLan) {
    for (const ip of lanAddresses()) {
      console.log(`  on your phone    http://${ip}:${argPort()}  (same Wi-Fi)`);
    }
    console.log('  LAN mode is on (--lan). Windows may ask once to allow Node through the firewall — allow it for private networks only.');
  } else {
    console.log('  phone access     restart with: npm run serve -- --lan');
  }
  console.log(`  watching         ${saveDirectory}`);
  console.log('  save in game and the page updates itself. Ctrl-C to stop.\n');

  const shutdown = (): void => {
    watcher.stop();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
