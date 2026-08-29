import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RoundResult, SlotFixture } from '../src/parser/fixtures.ts';
import {
  anchorSlots,
  buildStandings,
  compForLeague,
  competitionSlots,
  fixturesForSlot,
} from '../src/engine/standings.ts';

const fx = (
  date: number,
  slotA: number,
  goalsA: number | null,
  slotB: number,
  goalsB: number | null,
  comp = 808,
): SlotFixture => ({ date, kickoff: 1500, comp, slotA, slotB, goalsA, goalsB });

const res = (date: number, home: number, away: number, hg: number, ag: number, league = 13): RoundResult => ({
  date,
  homeTeamId: home,
  awayTeamId: away,
  homeGoals: hg,
  awayGoals: ag,
  leagueId: league,
  standoutPlayerId: null,
});

describe('buildStandings', () => {
  const season = [
    fx(20270814, 1, 2, 2, 1),
    fx(20270814, 3, 0, 4, 0),
    fx(20270821, 2, 3, 3, 0),
    fx(20270821, 4, 1, 1, 1),
    fx(20270828, 1, 0, 3, 2),
    fx(20270828, 2, 2, 4, 0),
    // still to play
    fx(20270904, 3, null, 1, null),
    fx(20270904, 4, null, 2, null),
  ];

  it('adds up points, goals and form from played fixtures only', () => {
    const table = buildStandings(season, 808);
    const two = table.find((r) => r.slot === 2)!;
    assert.equal(two.played, 3);
    assert.equal(two.won, 2);
    assert.equal(two.drawn, 0);
    assert.equal(two.lost, 1);
    assert.equal(two.goalsFor, 6);
    assert.equal(two.goalsAgainst, 2);
    assert.equal(two.points, 6);
    assert.deepEqual(two.form, ['L', 'W', 'W'], 'most recent last');
  });

  it('orders by points, then goal difference, then goals scored', () => {
    const table = buildStandings(season, 808);
    // Slots 1 and 3 both finish on four points and -1; slot 1 goes above on
    // goals scored, 3 to 2.
    assert.deepEqual(
      table.map((r) => r.slot),
      [2, 1, 3, 4],
    );
    assert.deepEqual(
      table.map((r) => r.position),
      [1, 2, 3, 4],
    );
  });

  it('gives a slot no result has named a null club rather than a guess', () => {
    const table = buildStandings(season, 808, (slot) => (slot === 2 ? 11 : null));
    assert.equal(table.find((r) => r.slot === 2)!.teamId, 11);
    assert.equal(table.find((r) => r.slot === 3)!.teamId, null);
  });

  it('leaves placeholder participants out of the table', () => {
    // A rearranged fixture is parked on a pair of stand-in slots.
    const withPlaceholder = [...season, fx(20280319, 900, null, 901, null)];
    assert.deepEqual(competitionSlots(withPlaceholder, 808), [1, 2, 3, 4]);
    assert.deepEqual(
      buildStandings(withPlaceholder, 808).map((r) => r.slot).sort((a, b) => a - b),
      [1, 2, 3, 4],
    );
  });
});

describe('anchorSlots', () => {
  const season = [fx(20270911, 1, 2, 2, 0), fx(20270911, 3, 1, 4, 1)];

  it('names both slots when exactly one fixture matches the result', () => {
    const anchors = anchorSlots(season, [res(20270911, 11, 9, 2, 0)]);
    assert.deepEqual(
      anchors.map((a) => [a.slot, a.teamId]).sort(),
      [
        [1, 11],
        [2, 9],
      ],
    );
    assert.equal(anchors[0]!.namedOn, 20270911);
  });

  it('refuses to guess when two fixtures share a date and scoreline', () => {
    const ambiguous = [fx(20270911, 1, 2, 2, 0), fx(20270911, 3, 2, 4, 0)];
    assert.deepEqual(anchorSlots(ambiguous, [res(20270911, 11, 9, 2, 0)]), []);
  });

  it('uses what it already knows to break a tie on the next sweep', () => {
    const ambiguous = [fx(20270911, 1, 2, 2, 0), fx(20270911, 3, 2, 4, 0)];
    // The 1-1 names slots 3 and 4 outright; that rules their fixture out of the
    // 2-0, leaving one candidate.
    const anchors = anchorSlots(
      [...ambiguous, fx(20270911, 3, 1, 4, 1)],
      [res(20270911, 5, 7, 1, 1), res(20270911, 11, 9, 2, 0)],
    );
    const byTeam = new Map(anchors.map((a) => [a.teamId, a.slot]));
    assert.equal(byTeam.get(5), 3);
    assert.equal(byTeam.get(7), 4);
    assert.equal(byTeam.get(11), 1);
    assert.equal(byTeam.get(9), 2);
  });

  it('finds which competition group a league is', () => {
    const anchors = anchorSlots(season, [res(20270911, 11, 9, 2, 0)]);
    assert.equal(compForLeague(anchors, (id) => (id === 11 || id === 9 ? 13 : null), 13), 808);
    assert.equal(compForLeague(anchors, () => 13, 19), null);
  });
});

describe('fixturesForSlot', () => {
  it('lists one club season in date order, home and away, played and not', () => {
    const season = [fx(20270911, 1, 4, 2, 0), fx(20270919, 3, null, 1, null)];
    const mine = fixturesForSlot(season, 808, 1, (slot) => (slot === 2 ? 9 : null));
    assert.deepEqual(mine, [
      {
        date: 20270911,
        kickoff: 1500,
        comp: 808,
        home: true,
        opponentSlot: 2,
        opponentTeamId: 9,
        goalsFor: 4,
        goalsAgainst: 0,
        result: 'W',
      },
      {
        date: 20270919,
        kickoff: 1500,
        comp: 808,
        home: false,
        opponentSlot: 3,
        opponentTeamId: null,
        goalsFor: null,
        goalsAgainst: null,
        result: null,
      },
    ]);
  });
});
