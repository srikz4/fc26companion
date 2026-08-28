import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { unpackDatabases } from '../src/parser/dbReader.ts';
import { decodeName, displayName } from '../src/parser/nameCodec.ts';
import { parseDbMeta } from '../src/parser/meta.ts';

describe('decodeName', () => {
  const field = (...parts: (string | number[])[]): Uint8Array => {
    const bytes = parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'utf8')] : p));
    return Uint8Array.from([...bytes, ...new Array(45 - bytes.length).fill(0)]);
  };

  test('reads a plain name and stops at the first null', () => {
    assert.deepEqual(decodeName(field('Lino')), { text: 'Lino', complete: true });
  });

  test('preserves accented characters via UTF-8', () => {
    // The FC 25 reader decoded latin1 then stripped everything outside printable
    // ASCII, turning "Otávio" into "Otvio". spec.md §2.2 change 3.
    assert.deepEqual(decodeName(field('Otávio')), { text: 'Otávio', complete: true });
  });

  test('falls back to latin1 for invalid UTF-8', () => {
    assert.equal(decodeName(field([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72])).text, 'Müller');
  });

  test('detects the u16 prefix-dictionary form and refuses to invent the prefix', () => {
    // 0x0017 + "rtín" is Martín in this save; the dictionary is not in the file.
    const decoded = decodeName(field([0x17, 0x00], 'rtín'));
    assert.equal(decoded.complete, false);
    assert.equal(decoded.prefixCode, 0x17);
    assert.equal(decoded.text, 'rtín');
  });

  test('an incomplete name never renders', () => {
    assert.equal(displayName(decodeName(field([0x21, 0x00], 'tur'))), null);
    assert.equal(displayName(decodeName(field('Artur'))), 'Artur');
  });

  test('a one-character name is plain, not a prefix code', () => {
    assert.deepEqual(decodeName(field('A')), { text: 'A', complete: true });
  });

  test('returns empty for an all-null field', () => {
    assert.deepEqual(decodeName(field()), { text: '', complete: true });
  });
});

describe('unpackDatabases', () => {
  test('returns nothing when the signature is absent', () => {
    assert.deepEqual(unpackDatabases(Buffer.alloc(64)), []);
  });

  test('rejects a database whose declared size overruns the buffer', () => {
    const buf = Buffer.alloc(32);
    Buffer.from([0x44, 0x42, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]).copy(buf, 0);
    buf.writeUInt32LE(0xffff, 8);
    assert.throws(() => unpackDatabases(buf), /invalid size/);
  });
});

describe('parseDbMeta', () => {
  const xml = `<database>
    <table name="players" shortname="plyr">
      <fields>
        <field name="playerid" shortname="pcid" type="DBOFIELDTYPE_INTEGER" rangelow="0" key="True"/>
        <field name="overallrating" shortname="ovrl" type="DBOFIELDTYPE_INTEGER" rangelow="1"/>
        <field name="firstname" shortname="fnam" type="DBOFIELDTYPE_STRING"/>
      </fields>
    </table>
  </database>`;

  test('maps shortnames, rangelows and primary keys', () => {
    const meta = parseDbMeta(xml);
    assert.equal(meta.tableNames.get('plyr'), 'players');
    assert.equal(meta.fieldNames.get('ovrl'), 'overallrating');
    assert.equal(meta.fieldRange.get('playersoverallrating'), 1);
    assert.equal(meta.primaryKeys.get('players'), 'playerid');
  });

  test('gives string fields a zero rangelow', () => {
    assert.equal(parseDbMeta(xml).fieldRange.get('playersfirstname'), 0);
  });

  test('rejects a meta document with no tables', () => {
    assert.throws(() => parseDbMeta('<database></database>'), /no <table>/);
  });
});
