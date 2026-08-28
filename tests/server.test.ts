/**
 * The auto-refresh path: a save lands, the watcher ingests it, and every open
 * page is told. This is the one behaviour the user never triggers by hand, so it
 * is the one most worth a test.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { HistoryStore } from '../src/store/store.ts';
import { SaveWatcher } from '../src/watcher/watcher.ts';
import { ViewServer } from '../src/server/server.ts';
import { listManagerCareerSaves } from '../src/core/saveLocation.ts';

const meta = loadDbMeta(fileURLToPath(new URL('../data/fifa_ng_db-meta.xml', import.meta.url)));
const WEB_ROOT = fileURLToPath(new URL('../web', import.meta.url));
const FC26_DIR = join(process.env['LOCALAPPDATA'] ?? '', 'EA SPORTS FC 26', 'settings');
const realSave = existsSync(FC26_DIR) ? listManagerCareerSaves(FC26_DIR)[0] : undefined;

describe('ViewServer', () => {
  let server: ViewServer;
  let base: string;
  let doc: unknown = { hello: 'world' };

  before(async () => {
    server = new ViewServer({ port: 0, webRoot: WEB_ROOT, provider: { get: () => doc } });
    base = await server.listen();
  });

  after(() => server.close());

  test('serves the view document', async () => {
    const response = await fetch(`${base}/api/view`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hello: 'world' });
  });

  test('serves the page', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /Companion/);
  });

  test('refuses to serve outside the web root', async () => {
    for (const path of ['/../package.json', '/..%2Fpackage.json', '/../../etc/passwd']) {
      const response = await fetch(`${base}${path}`);
      assert.ok(response.status === 403 || response.status === 404, `${path} returned ${response.status}`);
      assert.doesNotMatch(await response.text(), /"dependencies"/);
    }
  });

  test('a missing file is a 404, not a crash', async () => {
    assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  });

  test('pushes an event to a connected page', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = response.body!.getReader();
    await reader.read(); // the initial retry hint

    const received = reader.read();
    // Give the connection a moment to register before broadcasting.
    await new Promise((r) => setTimeout(r, 50));
    server.broadcast('refresh', { file: 'CmMgrC1' });

    const chunk = await received;
    const text = new TextDecoder().decode(chunk.value);
    controller.abort();
    await reader.cancel().catch(() => {});
    assert.match(text, /event: refresh/);
    assert.match(text, /CmMgrC1/);
  });
});

describe('save lands -> page is told', { skip: !realSave }, () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'fc26-serve-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('ingesting a save broadcasts a refresh', async () => {
    const store = new HistoryStore(':memory:');
    const server = new ViewServer({ port: 0, webRoot: WEB_ROOT, provider: { get: () => ({}) } });
    const base = await server.listen();

    const watcher = new SaveWatcher({
      saveDirectory: dir,
      snapshotDirectory: join(dir, 'snapshots'),
      meta,
      store,
    });
    watcher.on('processed', (event) => server.broadcast('refresh', { file: event.file }));

    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();

    const received = reader.read();
    await new Promise((r) => setTimeout(r, 50));

    writeFileSync(join(dir, 'CmMgrC20260828010627834'), readFileSync(realSave!.path));
    const event = await watcher.ingestLatest();
    assert.ok(event, 'the save was not ingested');

    const text = new TextDecoder().decode((await received).value);
    controller.abort();
    await reader.cancel().catch(() => {});
    watcher.stop();
    server.close();
    store.close();
    assert.match(text, /event: refresh/);
    assert.match(text, /CmMgrC20260828010627834/);
  });
});
