import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createNameResolver,
  parseCsvLine,
  parseNameTable,
  sanitiseName,
  loadNameTable,
  EMPTY_NAME_TABLE,
} from '../src/names/nameTable.ts';
import type { Tables } from '../src/parser/dbReader.ts';

const NAMES_PATH = fileURLToPath(new URL('../data/playernames_fc26.csv', import.meta.url));

describe('parseCsvLine', () => {
  test('handles quoted fields with commas', () => {
    assert.deepEqual(parseCsvLine('1,"Silva, da Costa",x'), ['1', 'Silva, da Costa', 'x']);
  });

  test('handles doubled quotes', () => {
    assert.deepEqual(parseCsvLine('1,"He said ""hi""",2'), ['1', 'He said "hi"', '2']);
  });

  test('keeps empty trailing cells', () => {
    assert.deepEqual(parseCsvLine('a,,'), ['a', '', '']);
  });
});

describe('sanitiseName', () => {
  test('keeps Latin letters, marks, apostrophes and hyphens', () => {
    assert.equal(sanitiseName("Noussair O'Neill-Šeško"), "Noussair O'Neill-Šeško");
  });

  test('cuts a second script appended to the Latin form', () => {
    // Observed in the source data: "Noussair Mazraouiنصير مزراوي".
    assert.equal(sanitiseName('Noussair Mazraouiنصير مزراوي'), 'Noussair Mazraoui');
  });
});

describe('parseNameTable', () => {
  const csv = [
    'player_id,short_name,long_name,overall',
    '212198,Bruno Fernandes,Bruno Miguel Borges Fernandes,87',
    '243014,B. Mbeumo,"Bryan Tetsadong Marceau Mbeumo",85',
    'x,Broken,Broken,1',
    '999,,,50',
  ].join('\n');

  test('reads names by player_id and skips unusable rows', () => {
    const table = parseNameTable(csv, 'test');
    assert.equal(table.byPlayerId.size, 2);
    assert.equal(table.byPlayerId.get(212198)?.short, 'Bruno Fernandes');
    assert.equal(table.byPlayerId.get(243014)?.full, 'Bryan Tetsadong Marceau Mbeumo');
  });

  test('skips our own provenance comment lines', () => {
    const table = parseNameTable(`# source: somewhere\n# imported: today\n${csv}`, 'test');
    assert.equal(table.byPlayerId.size, 2);
  });

  test('refuses a table without player_id rather than guessing a column', () => {
    assert.throws(() => parseNameTable('nameid,name\n1,Foo', 'test'), /player_id/);
  });

  test('refuses a table with no name column', () => {
    assert.throws(() => parseNameTable('player_id,overall\n1,80', 'test'), /short_name/);
  });
});

describe('name resolution order', () => {
  const tables: Tables = {
    editedplayernames: [
      { playerid: 460012, firstname: 'Otávio', surname: 'Campos', commonname: '' },
      // A prefix-compressed first name decoded to '' upstream; the surname is whole.
      { playerid: 460029, firstname: '', surname: 'Luna', commonname: '' },
      { playerid: 460099, firstname: '', surname: '', commonname: '' },
    ],
  };
  const table = parseNameTable(
    'player_id,short_name,long_name\n212198,Bruno Fernandes,Bruno Miguel Borges Fernandes\n460012,WRONG,WRONG',
    'test',
  );

  test('the save’s own strings win over an imported table', () => {
    const r = createNameResolver(tables, table).resolve(460012);
    assert.equal(r.display, 'Otávio Campos');
    assert.equal(r.origin, 'edited');
  });

  test('a whole surname is used even when the first name could not be decoded', () => {
    const r = createNameResolver(tables, table).resolve(460029);
    assert.equal(r.display, 'Luna');
  });

  test('the imported table resolves everyone else', () => {
    const r = createNameResolver(tables, table).resolve(212198);
    assert.equal(r.display, 'Bruno Fernandes');
    assert.equal(r.origin, 'imported');
  });

  test('an unknown player is an id, never a guess', () => {
    for (const resolver of [createNameResolver(tables, table), createNameResolver(tables)]) {
      const r = resolver.resolve(79399);
      assert.equal(r.display, '#79399');
      assert.equal(r.origin, 'unresolved');
    }
  });

  test('an empty edited row does not shadow the imported table', () => {
    const r = createNameResolver(tables, table).resolve(460099);
    assert.equal(r.origin, 'unresolved');
  });

  test('with no table imported, everyone is an id', () => {
    const resolver = createNameResolver({}, EMPTY_NAME_TABLE);
    assert.equal(resolver.resolve(212198).display, '#212198');
  });
});

describe('the imported FC 26 name table', { skip: !existsSync(NAMES_PATH) }, () => {
  test('resolves known EA player ids to the right players', () => {
    const table = loadNameTable(NAMES_PATH);
    assert.ok(table.byPlayerId.size > 15000, `only ${table.byPlayerId.size} names`);
    // Cross-checked against the save: heights and club match (spec.md §2.5).
    assert.match(table.byPlayerId.get(212198)?.full ?? '', /Bruno .*Fernandes/);
    assert.match(table.byPlayerId.get(243014)?.full ?? '', /Mbeumo/);
  });

  test('carries no ratings — names only', () => {
    const table = loadNameTable(NAMES_PATH);
    const entry = table.byPlayerId.get(212198)!;
    assert.deepEqual(Object.keys(entry).sort(), ['full', 'short']);
  });
});
