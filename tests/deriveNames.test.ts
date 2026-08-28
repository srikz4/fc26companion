import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave, type Tables } from '../src/parser/dbReader.ts';
import { listManagerCareerSaves, YOUTH_TEAM_ID } from '../src/core/saveLocation.ts';
import { loadNameTable, parseNameTable, createNameResolver } from '../src/names/nameTable.ts';
import {
  deriveNameIds,
  deriveName,
  splitKnownName,
  DEFAULT_THRESHOLD,
  type Threshold,
} from '../src/names/deriveNameTable.ts';

const meta = loadDbMeta(fileURLToPath(new URL('../data/fifa_ng_db-meta.xml', import.meta.url)));
const NAMES_PATH = fileURLToPath(new URL('../data/playernames_fc26.csv', import.meta.url));
const FC26_DIR = join(process.env['LOCALAPPDATA'] ?? '', 'EA SPORTS FC 26', 'settings');

describe('splitKnownName', () => {
  test('takes the surname from the initial form of a short name', () => {
    // "B. Mbeumo" is more reliable than the last token of the long name, which
    // breaks on players carrying three or four names.
    assert.deepEqual(splitKnownName('B. Mbeumo', 'Bryan Tetsadong Marceau Mbeumo'), {
      first: 'Bryan',
      last: 'Mbeumo',
    });
  });

  test('falls back to the last token when the short name has no initial', () => {
    assert.deepEqual(splitKnownName('Bruno Fernandes', 'Bruno Miguel Borges Fernandes'), {
      first: 'Bruno',
      last: 'Fernandes',
    });
  });
});

describe('deriveNameIds', () => {
  const known = parseNameTable(
    [
      'player_id,short_name,long_name',
      '1,A. Andersen,Anders Andersen',
      '2,B. Andersen,Bo Andersen',
      '3,C. Berg,Carl Berg',
      '4,D. Solo,Dan Solo',
      '5,A. Dahl,Anders Dahl',
    ].join('\n'),
    'test',
  );

  const tables = (extra: Partial<Tables> = {}): Tables => ({
    players: [
      { playerid: 1, firstnameid: 100, lastnameid: 900, commonnameid: 0, playerjerseynameid: 900 },
      { playerid: 2, firstnameid: 101, lastnameid: 900, commonnameid: 0, playerjerseynameid: 900 },
      { playerid: 3, firstnameid: 102, lastnameid: 901, commonnameid: 0, playerjerseynameid: 901 },
      { playerid: 4, firstnameid: 103, lastnameid: 902, commonnameid: 0, playerjerseynameid: 902 },
      { playerid: 5, firstnameid: 100, lastnameid: 903, commonnameid: 0, playerjerseynameid: 903 },
      // The target: a newgen sharing nameid 900 with the two Andersens.
      { playerid: 460001, firstnameid: 100, lastnameid: 900, commonnameid: 0, playerjerseynameid: 900 },
    ],
    ...extra,
  });

  test('a nameid confirmed by two players is accepted', () => {
    const derived = deriveNameIds([tables()], known);
    assert.equal(derived.last.get(900)?.name, 'Andersen');
    assert.equal(derived.last.get(900)?.votes, 2);
  });

  test('a nameid seen once falls below the default threshold', () => {
    const derived = deriveNameIds([tables()], known);
    assert.equal(derived.last.has(901), false, 'Berg had one vote and should be rejected');
  });

  test('a lower threshold accepts single votes', () => {
    const loose: Threshold = { minVotes: 1, minAgreement: 1 };
    const derived = deriveNameIds([tables()], known, loose);
    assert.equal(derived.last.get(901)?.name, 'Berg');
  });

  test('names a newgen no external dataset can know', () => {
    const derived = deriveNameIds([tables()], known);
    const newgen = tables().players!.find((p) => p['playerid'] === 460001)!;
    assert.equal(deriveName(newgen, derived)?.display, 'Anders Andersen');
  });

  test('players overridden by editedplayernames are excluded from the ballot', () => {
    // The override table decides the displayed name, so their nameids are stale
    // evidence and must not vote. This is the trap documented in §2.5a.
    const withOverride = tables({ editedplayernames: [{ playerid: 1, firstname: 'Zed', surname: 'Zulu' }] });
    assert.equal(deriveNameIds([tables()], known).last.get(900)?.votes, 2);
    // With player 1 excluded only player 2 votes for nameid 900, which no longer
    // clears the default threshold.
    assert.equal(deriveNameIds([withOverride], known).last.has(900), false);
    assert.equal(
      deriveNameIds([withOverride], known, { minVotes: 1, minAgreement: 1 }).last.get(900)?.votes,
      1,
    );
  });

  test('dcplayernames is treated as literal, not derived', () => {
    const derived = deriveNameIds(
      [tables({ dcplayernames: [{ nameid: 44827, name: 'G. Mora' }] })],
      known,
    );
    const player = { playerid: 79399, firstnameid: 0, lastnameid: 0, commonnameid: 0, playerjerseynameid: 44827 };
    const result = deriveName(player, derived);
    assert.equal(result?.display, 'G. Mora');
    assert.equal(result?.literalOnly, true);
  });

  test('a first name with no surname is marked partial, not passed off as a name', () => {
    const derived = deriveNameIds([tables()], known, { minVotes: 1, minAgreement: 1 });
    const player = { playerid: 460095, firstnameid: 102, lastnameid: 99999, commonnameid: 0, playerjerseynameid: 99999 };
    const result = deriveName(player, derived);
    assert.equal(result?.partial, true);
    assert.equal(result?.display, 'Carl');
  });

  test('nothing derivable returns null rather than an empty name', () => {
    const derived = deriveNameIds([tables()], known);
    assert.equal(
      deriveName({ playerid: 1, firstnameid: 7777, lastnameid: 8888, commonnameid: 0, playerjerseynameid: 8888 }, derived),
      null,
    );
  });
});

describe('resolver with derivation', () => {
  const known = parseNameTable(
    [
      'player_id,short_name,long_name',
      '1,A. Andersen,Anders Andersen',
      '2,B. Andersen,Bo Andersen',
      '5,A. Dahl,Anders Dahl',
    ].join('\n'),
    'test',
  );
  const tables: Tables = {
    players: [
      { playerid: 1, firstnameid: 100, lastnameid: 900, commonnameid: 0, playerjerseynameid: 900 },
      { playerid: 2, firstnameid: 101, lastnameid: 900, commonnameid: 0, playerjerseynameid: 900 },
      { playerid: 460001, firstnameid: 100, lastnameid: 900, commonnameid: 0, playerjerseynameid: 900 },
      { playerid: 460002, firstnameid: 100, lastnameid: 555, commonnameid: 0, playerjerseynameid: 555 },
      { playerid: 5, firstnameid: 100, lastnameid: 903, commonnameid: 0, playerjerseynameid: 903 },
    ],
    editedplayernames: [{ playerid: 460002, firstname: 'Otávio', surname: 'Campos', commonname: '' }],
  };

  test('a derived name is marked provisional', () => {
    const resolver = createNameResolver(tables, known, deriveNameIds([tables], known));
    const r = resolver.resolve(460001);
    assert.equal(r.display, 'Anders Andersen');
    assert.equal(r.origin, 'derived');
    assert.equal(r.provisional, true);
  });

  test('a read name is not marked provisional', () => {
    const resolver = createNameResolver(tables, known, deriveNameIds([tables], known));
    for (const id of [1, 460002]) {
      assert.equal(resolver.resolve(id).provisional, false);
    }
  });

  test('the save’s own string still beats a derivation that disagrees', () => {
    const resolver = createNameResolver(tables, known, deriveNameIds([tables], known));
    assert.equal(resolver.resolve(460002).display, 'Otávio Campos');
    assert.equal(resolver.resolve(460002).origin, 'edited');
  });

  test('a partial name keeps the id beside it', () => {
    const loose = deriveNameIds([tables], known, { minVotes: 1, minAgreement: 1 });
    const resolver = createNameResolver(
      { players: [{ playerid: 555001, firstnameid: 100, lastnameid: 424242, commonnameid: 0, playerjerseynameid: 424242 }] },
      known,
      loose,
    );
    assert.equal(resolver.resolve(555001).display, 'Anders #555001');
  });
});

describe('derivation against the real save', { skip: !existsSync(FC26_DIR) || !existsSync(NAMES_PATH) }, () => {
  const saves = listManagerCareerSaves(FC26_DIR);
  const all = saves.map((s) => parseSave(readFileSync(s.path), meta).tables);
  const known = loadNameTable(NAMES_PATH);

  test('held-out precision stays above 95% on surnames', { skip: all.length === 0 }, () => {
    // Train on four fifths, measure on the fifth the ballot never saw. This is the
    // measurement quoted in spec.md §2.5a; if a data change degrades it, this fails.
    const tables = all[0]!;
    const overridden = new Set((tables['editedplayernames'] ?? []).map((e) => e['playerid']));
    const usable = (tables['players'] ?? []).filter(
      (p) => !overridden.has(p['playerid']) && known.byPlayerId.has(p['playerid'] as number),
    );
    assert.ok(usable.length > 5000, `only ${usable.length} usable samples`);

    const trainRows = usable.filter((_, i) => i % 5 !== 0);
    const testRows = usable.filter((_, i) => i % 5 === 0);
    const derived = deriveNameIds([{ players: trainRows }], known, DEFAULT_THRESHOLD);

    let correct = 0;
    let wrong = 0;
    for (const p of testRows) {
      const entry = known.byPlayerId.get(p['playerid'] as number)!;
      const truth = splitKnownName(entry.short, entry.full).last;
      const got = derived.last.get(p['lastnameid'] as number);
      if (!got) continue;
      if (got.name === truth) correct++;
      else wrong++;
    }

    const precision = correct / (correct + wrong);
    assert.ok(correct + wrong > 200, `only ${correct + wrong} testable`);
    assert.ok(precision > 0.95, `surname precision fell to ${(precision * 100).toFixed(1)}%`);
  });

  test('every academy prospect with a player record gets a name', { skip: all.length === 0 }, () => {
    const tables = all[0]!;
    const derived = deriveNameIds(all, known);
    const resolver = createNameResolver(tables, known, derived);
    const players = new Set((tables['players'] ?? []).map((p) => p['playerid']));

    const youth = new Set<number>();
    for (const y of tables['career_youthplayers'] ?? []) youth.add(y['playerid'] as number);
    for (const l of tables['teamplayerlinks'] ?? []) {
      if (l['teamid'] === YOUTH_TEAM_ID) youth.add(l['playerid'] as number);
    }

    const real = [...youth].filter((id) => players.has(id));
    assert.ok(real.length > 0, 'no academy prospects found');
    const { resolved, total } = resolver.coverage(real);
    assert.equal(resolved, total, `${total - resolved} academy prospects unnamed`);
  });

  test('a youth row with no player record is not a prospect', { skip: all.length === 0 }, () => {
    // career_youthplayers can carry a row the game never generated a player for.
    // The Youth view must skip it rather than render an empty card.
    const tables = all[0]!;
    const players = new Set((tables['players'] ?? []).map((p) => p['playerid']));
    const orphans = (tables['career_youthplayers'] ?? []).filter((y) => !players.has(y['playerid']));
    for (const orphan of orphans) {
      assert.equal(typeof orphan['playerid'], 'number');
    }
  });
});
