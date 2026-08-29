import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blobSections, readFixtureLedger, readLatestResults } from '../src/parser/fixtures.ts';

/** A save is one `DB\0\x08` block followed by the tagged blob. */
function save(sections: { tag: string; body: Buffer }[]): Buffer {
  const dbSize = 16;
  const db = Buffer.alloc(dbSize);
  Buffer.from([0x44, 0x42, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]).copy(db, 0);
  db.writeUInt32LE(dbSize, 8);
  const parts = [db];
  for (const s of sections) {
    const head = Buffer.alloc(9);
    head[0] = 0x01;
    head.writeUInt32LE(4, 1);
    head.write(s.tag, 5, 'latin1');
    parts.push(head, s.body);
  }
  return Buffer.concat(parts);
}

interface Fx {
  date: number;
  kickoff?: number;
  slotA: number;
  goalsA: number | null;
  slotB: number;
  goalsB: number | null;
  comp: number;
}

/** One 22-byte mlop record. */
function fixture(f: Fx): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(f.date, 0);
  b.writeUInt16LE(f.kickoff ?? 1500, 4);
  b.writeUInt16LE(f.slotA, 6);
  b[8] = f.goalsA ?? 0xff;
  b[9] = 0xff;
  b.writeUInt16LE(f.slotB, 10);
  b[12] = f.goalsB ?? 0xff;
  b[13] = 0xff;
  b.writeUInt16LE(f.comp, 19);
  return b;
}

/** One 49-byte mrni record. */
function result(r: {
  date: number;
  home: number;
  away: number;
  hg: number;
  ag: number;
  league: number;
  standout?: number;
}): Buffer {
  const b = Buffer.alloc(49, 0xff);
  b.writeUInt32LE(r.date, 0);
  b.writeUInt32LE(r.home, 6);
  b.writeUInt32LE(r.away, 10);
  b.writeUInt32LE(r.hg, 14);
  b.writeUInt32LE(r.ag, 18);
  b.writeUInt16LE(r.league, 22);
  b.writeUInt32LE(r.standout ?? 0, 26);
  return b;
}

describe('blobSections', () => {
  it('finds each tagged section after the databases', () => {
    const s = save([
      { tag: 'mlop', body: Buffer.alloc(8) },
      { tag: 'mrni', body: Buffer.alloc(8) },
    ]);
    assert.deepEqual(
      blobSections(s).map((x) => x.tag),
      ['mlop', 'mrni'],
    );
  });

  it('returns nothing when there is no database block at all', () => {
    assert.deepEqual(blobSections(Buffer.from('not a save')), []);
  });
});

describe('readFixtureLedger', () => {
  it('reads date, kick-off, slots, goals and competition', () => {
    const body = Buffer.concat([
      fixture({ date: 20270911, kickoff: 1245, slotA: 2576, goalsA: 4, slotB: 2581, goalsB: 0, comp: 808 }),
      fixture({ date: 20270919, kickoff: 1330, slotA: 2580, goalsA: null, slotB: 2576, goalsB: null, comp: 808 }),
    ]);
    const read = readFixtureLedger(save([{ tag: 'mlop', body }]));
    assert.ok(read);
    const played = read.find((f) => f.date === 20270911)!;
    assert.deepEqual(played, {
      date: 20270911,
      kickoff: 1245,
      comp: 808,
      slotA: 2576,
      slotB: 2581,
      goalsA: 4,
      goalsB: 0,
    });
    const upcoming = read.find((f) => f.date === 20270919)!;
    assert.equal(upcoming.goalsA, null, 'an unplayed fixture has no score, not a zero');
    assert.equal(upcoming.goalsB, null);
  });

  it('rejects a record whose goal bytes are not a scoreline', () => {
    const b = fixture({ date: 20270911, slotA: 2576, goalsA: 4, slotB: 2581, goalsB: 0, comp: 808 });
    b[8] = 90; // no match ends 90-0
    assert.equal(readFixtureLedger(save([{ tag: 'mlop', body: b }])), null);
  });

  it('is null when the section is missing rather than empty', () => {
    assert.equal(readFixtureLedger(save([{ tag: 'mrni', body: Buffer.alloc(64) }])), null);
  });
});

describe('readLatestResults', () => {
  const leagueOf = (id: number): number | null => ({ 11: 13, 9: 13, 243: 53 })[id] ?? null;

  it('reads a round-up result with real club ids', () => {
    const body = result({ date: 20270911, home: 11, away: 9, hg: 4, ag: 0, league: 13, standout: 212198 });
    const read = readLatestResults(save([{ tag: 'mrni', body }]), leagueOf, (id) => id === 212198);
    assert.deepEqual(read, [
      {
        date: 20270911,
        homeTeamId: 11,
        awayTeamId: 9,
        homeGoals: 4,
        awayGoals: 0,
        leagueId: 13,
        standoutPlayerId: 212198,
      },
    ]);
  });

  it('drops a record whose two clubs are not in the same league', () => {
    const body = result({ date: 20270911, home: 11, away: 243, hg: 1, ag: 0, league: 13 });
    assert.equal(readLatestResults(save([{ tag: 'mrni', body }]), leagueOf), null);
  });

  it('keeps one copy when the round-up repeats the user own match', () => {
    const one = result({ date: 20270911, home: 11, away: 9, hg: 4, ag: 0, league: 13 });
    const read = readLatestResults(save([{ tag: 'mrni', body: Buffer.concat([one, one]) }]), leagueOf);
    assert.equal(read?.length, 1);
  });
});
