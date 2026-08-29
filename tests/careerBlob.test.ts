import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readShortlist } from '../src/parser/careerBlob.ts';

/** Build an mssm section exactly as observed in real saves (2026-08-29). */
function mssm(opts: { chunkCount: number; date?: number; ids?: number[] }): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
  parts.push(Buffer.from('feedface', 'hex')); // unrelated leading bytes
  parts.push(Buffer.from([0x01]), u32(4), Buffer.from('mssm', 'latin1'));
  parts.push(Buffer.from([0x01, 0x01]), u32(1), Buffer.from([0x00, 0x01]), u32(opts.chunkCount));
  if (opts.chunkCount > 0) {
    parts.push(Buffer.from([0x01]), u32(opts.date ?? 20270807), u32(5), Buffer.from([0x01]), u32((opts.ids ?? []).length));
    for (const id of opts.ids ?? []) parts.push(u32(id));
  }
  parts.push(Buffer.from([0x01]), u32(3)); // trailing field, as in the real blob
  return Buffer.concat(parts);
}

describe('readShortlist', () => {
  const players = new Set([252371, 77673, 460279, 461311]);
  const isPlayer = (id: number): boolean => players.has(id);

  test('reads the observed four-player list with its date', () => {
    const save = mssm({ chunkCount: 1, date: 20270807, ids: [252371, 77673, 460279, 461311] });
    assert.deepEqual(readShortlist(save, isPlayer), {
      ids: [252371, 77673, 460279, 461311],
      date: 20270807,
    });
  });

  test('a never-used shortlist (zero chunks) reads as empty, not unreadable', () => {
    assert.deepEqual(readShortlist(mssm({ chunkCount: 0 }), isPlayer), { ids: [], date: null });
  });

  test('refuses an id that is not a player rather than guessing', () => {
    const save = mssm({ chunkCount: 1, ids: [252371, 999999999] });
    assert.equal(readShortlist(save, isPlayer), null);
  });

  test('refuses an implausible date', () => {
    const save = mssm({ chunkCount: 1, date: 19000101, ids: [252371] });
    assert.equal(readShortlist(save, isPlayer), null);
  });

  test('refuses a save with no mssm section', () => {
    assert.equal(readShortlist(Buffer.from('no section here'), isPlayer), null);
  });

  test('refuses a count beyond the shortlist cap', () => {
    const ids = Array.from({ length: 101 }, () => 252371);
    const save = mssm({ chunkCount: 1, ids });
    assert.equal(readShortlist(save, isPlayer), null);
  });
});
