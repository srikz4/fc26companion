import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave, type Tables, type ParseResult } from '../src/parser/dbReader.ts';
import { HistoryStore, hashSave, readCareerIdentity, estimateGameDate } from '../src/store/store.ts';
import { listManagerCareerSaves } from '../src/core/saveLocation.ts';

const meta = loadDbMeta(fileURLToPath(new URL('../data/fifa_ng_db-meta.xml', import.meta.url)));
const FC26_DIR = join(process.env['LOCALAPPDATA'] ?? '', 'EA SPORTS FC 26', 'settings');

/** A minimal synthetic save so the store is testable without a real file. */
function fakeParse(overrides: Partial<Tables> = {}): ParseResult {
  const tables: Tables = {
    career_users: [{ firstname: 'Marc', surname: 'Skinner', clubteamid: 11, seasoncount: 2 }],
    career_managerinfo: [{ clubteamid: 11, userid: 0 }],
    teams: [{ teamid: 11, teamname: 'Manchester United', overallrating: 80 }],
    teamplayerlinks: [
      { teamid: 11, playerid: 100, jerseynumber: 8, position: 14, form: 3, injury: 0 },
      { teamid: 11, playerid: 200, jerseynumber: 9, position: 25, form: 3, injury: 0 },
    ],
    players: [
      { playerid: 100, overallrating: 90, potential: 90, height: 179 },
      { playerid: 200, overallrating: 70, potential: 88, height: 190 },
    ],
    career_playercontract: [{ playerid: 100, wage: 60000, duration_months: 72 }],
    persistent_events: [{ eventdate: 20260916 }],
    ...overrides,
  };
  return { tables, databases: [{ index: 0, tables: Object.keys(tables) }], unknownTables: [], stats: [], incompleteNames: [] };
}

describe('career identity', () => {
  test('reads club and manager', () => {
    const id = readCareerIdentity(fakeParse().tables);
    assert.equal(id.clubTeamId, 11);
    assert.equal(id.clubName, 'Manchester United');
    assert.equal(id.managerName, 'Marc Skinner');
  });

  test('two managers at the same club are different careers', () => {
    const a = readCareerIdentity(fakeParse().tables);
    const b = readCareerIdentity(
      fakeParse({ career_users: [{ firstname: 'Chris', surname: 'Ace', clubteamid: 11, seasoncount: 4 }] }).tables,
    );
    assert.notEqual(a.identityKey, b.identityKey);
  });

  test('a save with no club is an error, not a default', () => {
    assert.throws(
      () => readCareerIdentity({ career_users: [], career_managerinfo: [] }),
      /no club/,
    );
  });
});

describe('in-game date estimate', () => {
  test('takes the latest dated row and reports its basis', () => {
    const { date, basis } = estimateGameDate(fakeParse().tables);
    assert.equal(date, 20260916);
    assert.equal(basis, 'persistent_events.eventdate');
  });

  test('ignores the dead career_calendar template', () => {
    // currdate reads 20080101 in every FC 25 and FC 26 save (spec.md §9 D-1).
    const { date } = estimateGameDate(
      fakeParse({ career_calendar: [{ currdate: 20080101 }], persistent_events: [] }).tables,
    );
    assert.equal(date, null);
  });

  test('returns null rather than a guess when nothing is dated', () => {
    const { date, basis } = estimateGameDate(fakeParse({ persistent_events: [] }).tables);
    assert.equal(date, null);
    assert.equal(basis, null);
  });
});

describe('HistoryStore', () => {
  const ingest = (store: HistoryStore, parsed: ParseResult, hash: string) =>
    store.ingest({ parsed, contentHash: hash, sourceFile: 'test', sizeBytes: 1, observedAt: new Date().toISOString() });

  test('ingests a snapshot and writes observations', () => {
    const store = new HistoryStore(':memory:');
    const result = ingest(store, fakeParse(), 'hash-a');
    assert.equal(result.duplicate, false);
    assert.equal(result.entities, 2);
    assert.ok(result.observations > 0);
    store.close();
  });

  test('re-ingesting identical bytes is a no-op', () => {
    const store = new HistoryStore(':memory:');
    ingest(store, fakeParse(), 'hash-a');
    const second = ingest(store, fakeParse(), 'hash-a');
    assert.equal(second.duplicate, true);
    assert.equal(second.observations, 0);
    assert.equal(store.snapshots(second.careerId).length, 1);
    store.close();
  });

  test('keeps parallel careers apart', () => {
    const store = new HistoryStore(':memory:');
    ingest(store, fakeParse(), 'hash-a');
    ingest(
      store,
      fakeParse({
        career_users: [{ firstname: 'Chris', surname: 'Ace', clubteamid: 11, seasoncount: 4 }],
      }),
      'hash-b',
    );
    assert.equal(store.careers().length, 2);
    store.close();
  });

  test('builds a series across snapshots, and never interpolates', () => {
    const store = new HistoryStore(':memory:');
    ingest(store, fakeParse(), 'hash-a');

    // Second snapshot: player 200 gained 3 overall; player 100 is absent from it.
    const later = fakeParse({
      players: [{ playerid: 200, overallrating: 73, potential: 88, height: 190 }],
      teamplayerlinks: [{ teamid: 11, playerid: 200, jerseynumber: 9, position: 25, form: 4, injury: 0 }],
    });
    const result = ingest(store, later, 'hash-b');

    const series = store.series(result.careerId, 200, 'overallrating');
    assert.deepEqual(series.map((s) => s.value), [70, 73]);

    // No row is invented for the snapshot player 100 was missing from.
    assert.equal(store.series(result.careerId, 100, 'overallrating').length, 1);
    store.close();
  });

  test('marks a departed player rather than deleting them', () => {
    const store = new HistoryStore(':memory:');
    ingest(store, fakeParse(), 'hash-a');
    const later = fakeParse({
      players: [{ playerid: 200, overallrating: 73, potential: 88, height: 190 }],
      teamplayerlinks: [{ teamid: 11, playerid: 200, jerseynumber: 9, position: 25, form: 4, injury: 0 }],
    });
    const result = ingest(store, later, 'hash-b');

    // History for the departed player survives.
    assert.equal(store.series(result.careerId, 100, 'overallrating')[0]?.value, 90);
    store.close();
  });

  test('stores undecodable name fragments instead of discarding them', () => {
    const store = new HistoryStore(':memory:');
    const parsed = fakeParse();
    parsed.incompleteNames.push({
      table: 'editedplayernames',
      field: 'firstname',
      row: 2,
      prefixCode: 0x17,
      suffix: 'rtín',
    });
    const result = ingest(store, parsed, 'hash-a');
    assert.equal(result.duplicate, false);
    store.close();
  });
});

describe('store against a real save', { skip: !existsSync(FC26_DIR) }, () => {
  const saves = listManagerCareerSaves(FC26_DIR);

  test('ingests every save on this machine without error', { skip: saves.length === 0 }, () => {
    const store = new HistoryStore(':memory:');
    for (const save of saves) {
      const bytes = readFileSync(save.path);
      const result = store.ingest({
        parsed: parseSave(bytes, meta),
        contentHash: hashSave(bytes),
        sourceFile: save.path,
        sizeBytes: bytes.length,
      });
      assert.equal(result.duplicate, false);
      assert.ok(result.entities >= 11, `${save.fileName}: only ${result.entities} players tracked`);
      assert.ok(result.observations > 500, `${save.fileName}: only ${result.observations} observations`);
      assert.ok(result.gameDate !== null && result.gameDateBasis !== null);
    }
    // Each save on this machine is a different career.
    assert.equal(store.careers().length, saves.length);
    store.close();
  });
});
