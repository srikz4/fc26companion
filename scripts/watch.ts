/**
 * Run the save watcher.
 *
 *   npm run watch                 # backfill what exists, then watch for new saves
 *   npm run watch -- --once       # ingest the newest save and exit
 *   npm run watch -- --backfill   # ingest every save present and exit
 *   npm run watch -- --status     # print what the store holds and exit
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { HistoryStore } from '../src/store/store.ts';
import { SaveWatcher, type ProcessedEvent } from '../src/watcher/watcher.ts';
import { resolveSaveDirectory, YOUTH_TEAM_ID } from '../src/core/saveLocation.ts';
import { createNameResolver, loadNameTable } from '../src/names/nameTable.ts';
import { deriveNameIds } from '../src/names/deriveNameTable.ts';
import { parseSave } from '../src/parser/dbReader.ts';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const META_PATH = join(root, 'data', 'fifa_ng_db-meta.xml');
const NAMES_PATH = join(root, 'data', 'playernames_fc26.csv');
const STORE_PATH = join(root, 'store', 'history.sqlite');
const SNAPSHOT_DIR = join(root, 'snapshots');

const fmtDate = (d: number | null): string =>
  d === null ? 'unknown' : String(d).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

function report(event: ProcessedEvent): void {
  const { result } = event;
  console.log(
    `+ ${event.file}\n` +
      `  ${result.identity.clubName ?? '?'} · ${result.identity.managerName ?? '?'}` +
      `  ·  ~${fmtDate(result.gameDate)} (est. from ${result.gameDateBasis ?? 'nothing'})\n` +
      `  snapshot ${result.snapshotId}: ${result.entities} players, ` +
      `${result.observations.toLocaleString('en-GB')} observations, parsed in ${event.parseMs} ms`,
  );
}

function printStatus(store: HistoryStore): void {
  const careers = store.careers();
  if (careers.length === 0) {
    console.log('store is empty — run `npm run watch -- --backfill` or play and save.');
    return;
  }
  for (const career of careers) {
    console.log(`\n${career.clubName ?? '?'} · ${career.managerName ?? '?'}  (career ${career.careerId})`);
    for (const s of store.snapshots(career.careerId)) {
      console.log(
        `  snapshot ${String(s.snapshotId).padStart(3)}  ~${fmtDate(s.gameDate)}` +
          `  season ${s.season ?? '?'}  ingested ${s.observedAt.slice(0, 19).replace('T', ' ')}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const store = new HistoryStore(STORE_PATH);

  if (args.has('--status')) {
    printStatus(store);
    store.close();
    return;
  }

  const saveDirectory = resolveSaveDirectory();
  if (!saveDirectory) {
    console.error('No FC 26 settings directory found. Is the game installed for this user?');
    process.exit(1);
  }

  const meta = loadDbMeta(META_PATH);
  const names = loadNameTable(NAMES_PATH);
  console.log(`watching ${saveDirectory}`);
  console.log(`store    ${STORE_PATH}`);
  console.log(
    `names    ${names.byPlayerId.size ? `${names.byPlayerId.size.toLocaleString('en-GB')} imported` : 'none imported — players show as #id'}\n`,
  );

  const watcher = new SaveWatcher({ saveDirectory, snapshotDirectory: SNAPSHOT_DIR, meta, store });
  watcher.on('processed', report);
  watcher.on('skipped', (file, reason) => console.log(`. ${file} (${reason})`));
  watcher.on('error', (error, file) => console.error(`! ${file}: ${error.message}`));

  if (args.has('--once')) {
    const event = await watcher.ingestLatest();
    if (!event) console.log('nothing new to ingest.');
  } else {
    const events = await watcher.ingestAll();
    console.log(`\nbackfilled ${events.length} new snapshot(s).`);
  }

  // Name coverage for the current squad, so the id-vs-name situation is visible.
  const { listManagerCareerSaves } = await import('../src/core/saveLocation.ts');
  const present = listManagerCareerSaves(saveDirectory);
  const latest = present[0] ?? null;

  if (latest) {
    // Pool the nameid ballot across every save on disk: more careers, more
    // evidence for the same base table (spec.md §2.5a).
    const parsedAll = present.map((s) => parseSave(readFileSync(s.path), meta).tables);
    const tables = parsedAll[0]!;
    const resolver = createNameResolver(tables, names, deriveNameIds(parsedAll, names));

    const clubId = tables['career_users']?.[0]?.['clubteamid'];
    const squad = (tables['teamplayerlinks'] ?? [])
      .filter((l) => l['teamid'] === clubId)
      .map((l) => l['playerid'])
      .filter((v): v is number => typeof v === 'number');

    const youth = new Set<number>();
    for (const y of tables['career_youthplayers'] ?? []) {
      if (typeof y['playerid'] === 'number') youth.add(y['playerid']);
    }
    for (const l of tables['teamplayerlinks'] ?? []) {
      if (l['teamid'] === YOUTH_TEAM_ID && typeof l['playerid'] === 'number') youth.add(l['playerid']);
    }
    // A youth row with no player record is not a prospect (spec.md §2.5a).
    const known = new Set((tables['players'] ?? []).map((p) => p['playerid']));
    const prospects = [...youth].filter((id) => known.has(id));

    const s = resolver.coverage(squad);
    const y = resolver.coverage(prospects);
    console.log(`names    squad ${s.resolved}/${s.total}, academy ${y.resolved}/${y.total}`);
  }

  if (args.has('--once') || args.has('--backfill')) {
    store.close();
    return;
  }

  watcher.start();
  console.log('\nwatching for saves. Ctrl-C to stop.');
  process.on('SIGINT', () => {
    watcher.stop();
    store.close();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
