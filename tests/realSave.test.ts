/**
 * Integration tests against real save files on this machine.
 *
 * The domain-range block is the regression test for the field-alignment bug
 * (spec.md §1.4). Before the fix these saves parsed with `finishing: 100000` and
 * `strength: 161`; every range assertion below would have failed. Any future
 * change that shifts field names by one will fail here loudly instead of shipping
 * confident nonsense.
 *
 * Skipped, not failed, when a save is absent — these are machine-local fixtures.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave, type Row, type Tables } from '../src/parser/dbReader.ts';
import { listManagerCareerSaves, MANAGER_CAREER_PATTERN } from '../src/core/saveLocation.ts';

const meta = loadDbMeta(fileURLToPath(new URL('../data/fifa_ng_db-meta.xml', import.meta.url)));

const FC26_DIR = join(process.env['LOCALAPPDATA'] ?? '', 'EA SPORTS FC 26', 'settings');
const FC25_DIR = join(process.env['LOCALAPPDATA'] ?? '', 'EA SPORTS FC 25', 'settings');

const num = (row: Row, key: string): number | null =>
  typeof row[key] === 'number' ? (row[key] as number) : null;
const rows = (t: Tables, name: string): Row[] => t[name] ?? [];

/** Every player row must sit inside the game's own domain for these fields. */
function assertPlayerDomains(players: Row[], label: string): void {
  const ranges: [string, number, number][] = [
    ['overallrating', 1, 99],
    ['potential', 1, 99],
    ['height', 140, 220],
    ['weight', 40, 130],
    ['preferredfoot', 1, 2],
    ['skillmoves', 0, 5],
    ['weakfootabilitytypecode', 0, 5],
    ['acceleration', 1, 99],
    ['sprintspeed', 1, 99],
    ['finishing', 1, 99],
    ['shortpassing', 1, 99],
    ['strength', 1, 99],
    ['stamina', 1, 99],
    ['dribbling', 1, 99],
  ];

  for (const [field, lo, hi] of ranges) {
    const offenders = players.filter((p) => {
      const v = num(p, field);
      return v === null || v < lo || v > hi;
    });
    assert.equal(
      offenders.length,
      0,
      `${label}: ${offenders.length} of ${players.length} rows have ${field} outside ${lo}..${hi}` +
        (offenders[0] ? ` (first: playerid ${num(offenders[0], 'playerid')} = ${offenders[0][field]})` : ''),
    );
  }
}

describe('FC 26 Manager Career save', { skip: !existsSync(FC26_DIR) }, () => {
  const saves = listManagerCareerSaves(FC26_DIR);

  test('the settings directory contains CmMgrC saves', () => {
    assert.ok(saves.length > 0, `no CmMgrC* files in ${FC26_DIR}`);
  });

  test('filenames match the FC 26 pattern, not the FC 25 one', () => {
    for (const s of saves) {
      assert.match(s.fileName, MANAGER_CAREER_PATTERN);
      assert.doesNotMatch(s.fileName, /^ManagerCareer/);
    }
  });

  for (const save of saves) {
    describe(save.fileName, () => {
      const result = parseSave(readFileSync(save.path), meta);
      const t = result.tables;

      test('holds exactly two databases', () => {
        assert.equal(result.databases.length, 2);
      });

      test('the meta XML names every non-empty table', () => {
        // `kepX` is the one unnamed shortname and it carries zero rows (spec.md §1.3).
        assert.deepEqual(result.unknownTables, ['kepX']);
        const empty = result.stats.filter((s) => s.rows === 0).map((s) => s.table);
        assert.ok(!empty.includes('players'));
      });

      test('unknown fields are confined to players and teams', () => {
        const affected = result.stats
          .filter((s) => s.unknownFields.length > 0 && s.rows > 0)
          .map((s) => s.table);
        for (const table of ['players', 'teams']) assert.ok(affected.includes(table));
      });

      test('parses a full player table', () => {
        assert.ok(rows(t, 'players').length > 15000, `only ${rows(t, 'players').length} players`);
      });

      test('every player row sits inside the game domain', () => {
        assertPlayerDomains(rows(t, 'players'), save.fileName);
      });

      test('potential is never below overall', () => {
        const bad = rows(t, 'players').filter(
          (p) => (num(p, 'potential') ?? 0) < (num(p, 'overallrating') ?? 0),
        );
        assert.equal(bad.length, 0, `${bad.length} players have potential below overall`);
      });

      test('the career resolves to a real club and manager', () => {
        const user = rows(t, 'career_users')[0];
        assert.ok(user, 'no career_users row');
        const clubId = num(user, 'clubteamid');
        const club = rows(t, 'teams').find((r) => num(r, 'teamid') === clubId);
        assert.ok(club, `club ${clubId} not in teams`);
        assert.ok(typeof club['teamname'] === 'string' && club['teamname'].length > 0);
        const ovr = num(club, 'overallrating');
        assert.ok(ovr !== null && ovr >= 40 && ovr <= 99, `club overall ${ovr}`);
      });

      test('the user squad is a plausible size', () => {
        const clubId = num(rows(t, 'career_users')[0]!, 'clubteamid');
        const squad = rows(t, 'teamplayerlinks').filter((l) => num(l, 'teamid') === clubId);
        assert.ok(squad.length >= 11 && squad.length <= 60, `squad size ${squad.length}`);
      });

      test('the tables the engine depends on are present', () => {
        for (const name of [
          'cm_teamsheets',
          'cm_mentalities',
          'formations',
          'career_playercontract',
          'career_playermatchratinghistory',
          'career_playergrowthuserseason',
          'career_youthplayers',
          'career_scouts',
        ]) {
          assert.ok(rows(t, name).length > 0, `${name} is empty`);
        }
      });

      test('formations carry real shape names', () => {
        const named = rows(t, 'formations').filter(
          (f) => typeof f['formationname'] === 'string' && /^\d(-\d)+$/.test(f['formationname']),
        );
        assert.ok(named.length > 0, 'no formation has a d-d-d name');
      });

      test('the fields the spec cut features for are still absent', () => {
        // spec.md §1.7. If a title update adds any of these, this fails and the
        // spec gets amended rather than the feature getting guessed at.
        const all = Object.entries(t).flatMap(([table, list]) =>
          Object.keys(list[0] ?? {}).map((k) => `${table}.${k}`),
        );
        for (const [label, re] of [
          ['development plan', /\b(development|training)plan|playerplan/i],
          ['sharpness/fitness', /sharp|fitness|fatigue|condition/i],
          ['fixture list', /fixture|schedule|nextmatch|nextopponent/i],
        ] as [string, RegExp][]) {
          assert.deepEqual(all.filter((f) => re.test(f)), [], `${label} appeared in the save`);
        }
      });
    });
  }
});

describe('FC 25 save (cross-title regression)', { skip: !existsSync(FC25_DIR) }, () => {
  // The same parser must still read the previous title, so the FC 26 fixes are
  // proven not to be FC 26-specific hacks.
  const fc25 = existsSync(FC25_DIR)
    ? readFileSync(join(FC25_DIR, 'ManagerCareer20260606180733248'))
    : null;

  test('parses an FC 25 Manager Career save with the same reader', { skip: !fc25 }, () => {
    const t = parseSave(fc25!, meta).tables;
    assert.ok(rows(t, 'players').length > 15000);
    assertPlayerDomains(rows(t, 'players'), 'FC 25');
    const user = rows(t, 'career_users')[0];
    assert.ok(user && typeof user['surname'] === 'string');
  });
});
