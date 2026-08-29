import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SlotFixture } from '../src/parser/fixtures.ts';
import { cascadeSlots, pairingsFromLineups, type Pairing } from '../src/engine/pairings.ts';
import { anchorSlots, completeByElimination, currentStreak } from '../src/engine/standings.ts';

const fx = (date: number, a: number, ga: number | null, b: number, gb: number | null, comp = 1): SlotFixture => ({
  date,
  kickoff: 1500,
  comp,
  slotA: a,
  slotB: b,
  goalsA: ga,
  goalsB: gb,
});

/** Lineup rows for a list of clubs, in the order the save stores them. */
const lineups = (clubs: number[]) =>
  clubs.flatMap((team, block) =>
    Array.from({ length: 3 }, (_, i) => ({ artificialkey: block * 10 + i, teamid: team })),
  );

describe('pairingsFromLineups', () => {
  const league = (id: number) => (id < 100 ? 13 : 19);

  it('pairs neighbouring blocks of the league we asked for', () => {
    assert.deepEqual(pairingsFromLineups(lineups([1, 2, 3, 4]), league, 13), [
      [1, 2],
      [3, 4],
    ]);
  });

  it('ignores clubs from other leagues, and the boundary they make', () => {
    assert.deepEqual(pairingsFromLineups(lineups([1, 2, 500, 501, 3, 4]), league, 13), [
      [1, 2],
      [3, 4],
    ]);
  });

  it('drops a run it cannot split evenly', () => {
    assert.deepEqual(pairingsFromLineups(lineups([1, 2, 3, 500]), league, 13), []);
  });

  it('takes none of a round that is not a clean matching of the division', () => {
    const clubs = [1, 2, 3, 4];
    // A cup week: two of the four last played abroad, so the round is partial.
    assert.deepEqual(pairingsFromLineups(lineups([1, 2, 500, 501]), league, 13, clubs), []);
    // The whole division, cleanly paired, is accepted.
    assert.deepEqual(pairingsFromLineups(lineups([1, 2, 3, 4]), league, 13, clubs), [
      [1, 2],
      [3, 4],
    ]);
  });

  it('refuses a reading that has a club playing twice', () => {
    assert.deepEqual(pairingsFromLineups(lineups([1, 2, 1, 3]), league, 13, [1, 2, 3]), []);
  });
});

describe('cascadeSlots', () => {
  // Four clubs, two rounds. Slot 10 is known to be club 1.
  const fixtures = [
    fx(20270911, 10, 2, 11, 0),
    fx(20270911, 12, 1, 13, 1),
    fx(20270918, 11, 0, 12, 3),
    fx(20270918, 13, 2, 10, 2),
  ];
  const pairings: Pairing[] = [
    { date: 20270911, teamA: 1, teamB: 2 },
    { date: 20270911, teamA: 3, teamB: 4 },
    { date: 20270918, teamA: 2, teamB: 3 },
    { date: 20270918, teamA: 4, teamB: 1 },
  ];

  it('spreads one known club through the rounds to name the rest', () => {
    const out = cascadeSlots(fixtures, 1, [{ comp: 1, slot: 10, teamId: 1, namedOn: 20270911 }], pairings);
    assert.equal(out.contradictions, 0);
    const named = new Map(out.anchors.map((a) => [a.slot, a.teamId]));
    assert.deepEqual([...named.entries()].sort(), [
      [10, 1],
      [11, 2],
      [12, 3],
      [13, 4],
    ]);
    assert.equal(out.learned, 3);
  });

  it('counts a pairing that fights a known club instead of overwriting it', () => {
    const out = cascadeSlots(
      fixtures,
      1,
      [
        { comp: 1, slot: 10, teamId: 1, namedOn: 20270911 },
        { comp: 1, slot: 11, teamId: 9, namedOn: 20270911 },
      ],
      [{ date: 20270911, teamA: 1, teamB: 2 }],
    );
    assert.equal(out.contradictions, 1);
    assert.equal(out.anchors.find((a) => a.slot === 11)?.teamId, 9, 'the earlier name stands');
  });

  it('names nothing when it knows nothing to start from', () => {
    assert.equal(cascadeSlots(fixtures, 1, [], pairings).learned, 0);
  });
});

describe('completeByElimination', () => {
  const fixtures = [fx(20270911, 10, 1, 11, 0), fx(20270918, 10, 1, 12, 0), fx(20270925, 11, 1, 12, 0)];

  it('names the last slot when only one club can be in it', () => {
    const out = completeByElimination(
      fixtures,
      1,
      [
        { comp: 1, slot: 10, teamId: 1, namedOn: 20270911 },
        { comp: 1, slot: 11, teamId: 2, namedOn: 20270911 },
      ],
      [1, 2, 3],
    );
    assert.deepEqual(out.at(-1), { comp: 1, slot: 12, teamId: 3, namedOn: null });
  });

  it('will not guess when two slots are still open', () => {
    const out = completeByElimination(fixtures, 1, [{ comp: 1, slot: 10, teamId: 1, namedOn: 20270911 }], [1, 2, 3]);
    assert.equal(out.length, 1);
  });
});

describe('anchorSlots rejects a competition of the wrong size', () => {
  // Two groups: comp 1 has four entrants, comp 2 has two.
  const fixtures = [
    fx(20270911, 10, 2, 11, 0, 1),
    fx(20270911, 12, 3, 13, 1, 1),
    fx(20270918, 10, 1, 12, 0, 1),
    fx(20270918, 11, 1, 13, 0, 1),
    fx(20270911, 20, 2, 21, 0, 2),
    fx(20270918, 21, 1, 20, 0, 2),
  ];
  // A two-club league whose result reads 2-0 — the same score as comp 1's.
  const result = {
    date: 20270911,
    homeTeamId: 500,
    awayTeamId: 501,
    homeGoals: 2,
    awayGoals: 0,
    leagueId: 19,
    standoutPlayerId: null,
  };

  it('puts the result in the group with the right number of clubs', () => {
    const anchors = anchorSlots(fixtures, [result], { leagueSize: (lg) => (lg === 19 ? 2 : 4) });
    assert.deepEqual(
      anchors.map((a) => [a.comp, a.slot, a.teamId]).sort(),
      [
        [2, 20, 500],
        [2, 21, 501],
      ],
    );
  });

  it('without the size to check against, the ambiguity stops it naming anything', () => {
    assert.deepEqual(anchorSlots(fixtures, [result]), []);
  });
});

describe('currentStreak', () => {
  it('counts back from the latest result', () => {
    assert.deepEqual(currentStreak(['L', 'D', 'W', 'W', 'W']), { kind: 'W', length: 3 });
    assert.deepEqual(currentStreak(['W', 'L', 'L']), { kind: 'L', length: 2 });
    assert.deepEqual(currentStreak(['D', 'D', 'D', 'D']), { kind: 'D', length: 4 });
  });

  it('is null before a ball is kicked', () => {
    assert.equal(currentStreak([]), null);
  });
});
