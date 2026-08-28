import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { HistoryStore } from '../src/store/store.ts';
import { SaveWatcher } from '../src/watcher/watcher.ts';
import { listManagerCareerSaves } from '../src/core/saveLocation.ts';

const meta = loadDbMeta(fileURLToPath(new URL('../data/fifa_ng_db-meta.xml', import.meta.url)));
const FC26_DIR = join(process.env['LOCALAPPDATA'] ?? '', 'EA SPORTS FC 26', 'settings');
const realSave = existsSync(FC26_DIR) ? listManagerCareerSaves(FC26_DIR)[0] : undefined;

describe('SaveWatcher', { skip: !realSave }, () => {
  let dir: string;
  let snapshots: string;
  let bytes: Buffer;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'fc26-watch-'));
    snapshots = join(dir, 'snapshots');
    bytes = readFileSync(realSave!.path);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('ingests a save dropped into the watched directory', async () => {
    const store = new HistoryStore(':memory:');
    const watcher = new SaveWatcher({ saveDirectory: dir, snapshotDirectory: snapshots, meta, store });

    writeFileSync(join(dir, 'CmMgrC20260823014825742'), bytes);
    const event = await watcher.ingestLatest();

    assert.ok(event, 'nothing was ingested');
    assert.equal(event.result.duplicate, false);
    assert.ok(event.result.entities >= 11);
    assert.equal(event.result.identity.clubName, 'Manchester United');
    store.close();
  });

  test('copies the save rather than moving or altering the original', async () => {
    const store = new HistoryStore(':memory:');
    const watcher = new SaveWatcher({ saveDirectory: dir, snapshotDirectory: snapshots, meta, store });
    const original = join(dir, 'CmMgrC20260823014825742');

    const event = await watcher.ingestLatest();
    assert.ok(event);
    assert.ok(existsSync(original), 'the original save is gone');
    assert.deepEqual(readFileSync(original), bytes, 'the original save was modified');
    assert.ok(existsSync(event.copiedTo), 'no snapshot copy was written');
    assert.deepEqual(readFileSync(event.copiedTo), bytes, 'the copy differs from the original');
    store.close();
  });

  test('the same bytes written twice produce one snapshot', async () => {
    const store = new HistoryStore(':memory:');
    const watcher = new SaveWatcher({ saveDirectory: dir, snapshotDirectory: snapshots, meta, store });

    const first = await watcher.process('CmMgrC20260823014825742');
    assert.ok(first);
    // Same file, unchanged: skipped on the content hash before any parse.
    const second = await watcher.process('CmMgrC20260823014825742');
    assert.equal(second, null);
    assert.equal(store.snapshots(first.result.careerId).length, 1);
    store.close();
  });

  test('a different filename holding identical bytes is still one snapshot', async () => {
    const store = new HistoryStore(':memory:');
    const watcher = new SaveWatcher({ saveDirectory: dir, snapshotDirectory: snapshots, meta, store });

    // The game writes a new timestamped file on each save; identical content must
    // not become a second point in history.
    writeFileSync(join(dir, 'CmMgrC20260823014825743'), bytes);
    const first = await watcher.process('CmMgrC20260823014825742');
    const second = await watcher.process('CmMgrC20260823014825743');

    assert.ok(first);
    assert.equal(second, null, 'a duplicate save created a second snapshot');
    assert.equal(store.snapshots(first.result.careerId).length, 1);
    store.close();
  });

  test('ignores files that are not Manager Career saves', async () => {
    const store = new HistoryStore(':memory:');
    const watcher = new SaveWatcher({ saveDirectory: dir, snapshotDirectory: snapshots, meta, store });

    for (const name of ['CmPlr20260822021252610', 'Squads20260814231309857', 'Settings20260823014704706']) {
      writeFileSync(join(dir, name), bytes);
    }
    const events = await watcher.ingestAll();

    assert.equal(events.length, 1, 'a non-career file was ingested');
    store.close();
  });

  test('debounces a burst of writes into one ingest', async () => {
    const store = new HistoryStore(':memory:');
    const watcher = new SaveWatcher({
      saveDirectory: dir,
      snapshotDirectory: snapshots,
      meta,
      store,
      debounceMs: 60,
    });

    const processed: string[] = [];
    watcher.on('processed', (e) => processed.push(e.file));
    watcher.start();

    // The game writes in several passes; only the settled result should be read.
    const target = join(dir, 'CmMgrC20260823014825744');
    for (let i = 0; i < 4; i++) {
      writeFileSync(target, bytes);
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 2500));

    watcher.stop();
    assert.ok(processed.length <= 1, `burst produced ${processed.length} ingests`);
    store.close();
  });
});
