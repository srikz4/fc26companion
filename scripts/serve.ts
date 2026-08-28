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
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave, type Tables } from '../src/parser/dbReader.ts';
import { HistoryStore, readCareerIdentity } from '../src/store/store.ts';
import { TagStore } from '../src/store/tags.ts';
import { SaveWatcher } from '../src/watcher/watcher.ts';
import { listManagerCareerSaves, resolveSaveDirectory } from '../src/core/saveLocation.ts';
import { createNameResolver, loadNameTable } from '../src/names/nameTable.ts';
import { deriveNameIds } from '../src/names/deriveNameTable.ts';
import { buildViewDocument, type ViewDocument } from '../src/engine/viewModel.ts';
import { ViewServer } from '../src/server/server.ts';
import { loadNations } from '../src/domain/nations.ts';
import { readFileSync as readFs, existsSync as existsFs } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const META_PATH = join(root, 'data', 'fifa_ng_db-meta.xml');
const NAMES_PATH = join(root, 'data', 'playernames_fc26.csv');
const NATIONS_PATH = join(root, 'data', 'nations_fc26.csv');
const STORE_PATH = join(root, 'store', 'history.sqlite');
const SNAPSHOT_DIR = join(root, 'snapshots');
const WEB_ROOT = join(root, 'web');

/**
 * `--lan` is the explicit opt-in the non-negotiables call for (spec.md §3):
 * without it the server binds loopback and no other device can reach it.
 * With it, any phone on your own network can open the printed address.
 */
const wantLan = process.argv.includes('--lan');

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) out.push(nic.address);
    }
  }
  return out;
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
  const tagStore = new TagStore(store.handle);

  let view: ViewDocument | null = null;
  let activeCareerId: number | undefined;
  let rebuilding = false;

  /** Reparse the newest save and rebuild the document the page reads. */
  const rebuild = (): void => {
    if (rebuilding) return;
    rebuilding = true;
    try {
      const present = listManagerCareerSaves(saveDirectory);
      const latest = present[0];
      if (!latest) {
        console.log('no save yet — waiting for the game to write one.');
        return;
      }

      const parsedAll: Tables[] = present.map(
        (s) => parseSave(readFileSync(s.path), meta).tables,
      );
      const tables = parsedAll[0]!;
      const resolver = createNameResolver(tables, names, deriveNameIds(parsedAll, names));

      // Match the store's career to the save we are rendering, so history and
      // watchlist belong to the same save lineage.
      const identity = readCareerIdentity(tables);
      const career =
        store.careers().find((c) => c.managerName === identity.managerName && c.clubName === identity.clubName) ??
        store.careers()[0];
      activeCareerId = career?.careerId;

      view = buildViewDocument({
        tables,
        resolver,
        store,
        careerId: activeCareerId,
        nameTableSize: names.byPlayerId.size,
        tags: activeCareerId === undefined ? undefined : tagStore.index(activeCareerId),
        nations,
        competitions,
      });

      console.log(
        `view  ${view.club.name ?? '?'} · ${view.senior.length} senior, ${view.academy.length} academy · ` +
          `${view.alerts.length} alerts · ${view.transfers.targets.length} targets · ` +
          `${view.synergy.partnerships.length} partnerships · fit MAE ${view.matchday.calibration.meanAbsoluteError ?? '?'}`,
      );
    } finally {
      rebuilding = false;
    }
  };

  const server = new ViewServer({
    port: argPort(),
    host: wantLan ? '0.0.0.0' : '127.0.0.1',
    webRoot: WEB_ROOT,
    facesRoot: join(root, 'data', 'faces'),
    provider: { get: () => view ?? { error: 'no save parsed yet' } },
    tags: {
      add: (gameId, tag, note) => {
        if (activeCareerId === undefined) throw new Error('no career loaded yet');
        tagStore.add(activeCareerId, gameId, tag, note);
        rebuild();
      },
      remove: (gameId, tag) => {
        if (activeCareerId === undefined) throw new Error('no career loaded yet');
        tagStore.remove(activeCareerId, gameId, tag);
        rebuild();
      },
    },
  });

  const watcher = new SaveWatcher({ saveDirectory, snapshotDirectory: SNAPSHOT_DIR, meta, store });

  watcher.on('processed', (event) => {
    console.log(
      `+ ${event.file}  snapshot ${event.result.snapshotId}: ` +
        `${event.result.entities} players, ${event.result.observations.toLocaleString('en-GB')} observations`,
    );
    rebuild();
    server.broadcast('refresh', { file: event.file, at: new Date().toISOString() });
  });
  watcher.on('error', (error, file) => console.error(`! ${file}: ${error.message}`));

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
