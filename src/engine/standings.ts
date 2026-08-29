/**
 * Standings and fixture lists, built from the save's own results.
 *
 * The save keeps no league table. It keeps every fixture and every scoreline,
 * and the game adds them up on the way to the screen; so does this. A row here
 * is arithmetic over played fixtures, never an estimate — if a match is not in
 * the save, it is not in the table.
 *
 * What the save does not keep is a map from a fixture's participant slot to a
 * club (see parser/fixtures.ts). Slots are named by the results round-up, one
 * round at a time, and the names carry forward in the store. Until a slot has
 * been named it stays null and the row renders as unknown — the table is still
 * true, it just has a gap where a badge would go.
 */

import type { RoundResult, SlotFixture } from '../parser/fixtures.ts';
import { UNKNOWN_SLOT } from '../parser/fixtures.ts';

export type Result = 'W' | 'D' | 'L';

export interface Standing {
  slot: number;
  /** The club, once something has named this slot. */
  teamId: number | null;
  position: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  /** Most recent last. The table reverses it for display. */
  form: Result[];
  /**
   * The run they are on right now, over the whole season rather than the last
   * five — a club six wins deep is a different story from one on three, and the
   * five-match window cannot tell them apart.
   */
  streak: { kind: Result; length: number } | null;
}

/** A slot named by a result we actually read. */
export interface SlotAnchor {
  comp: number;
  slot: number;
  teamId: number;
  /**
   * The date of the result that named it, for provenance. Null when the slot
   * was the last one left and its club was deduced rather than observed.
   */
  namedOn: number | null;
}

export interface AnchorOptions {
  /**
   * How many clubs a league has.
   *
   * Without this, a result can bind into the wrong competition: a Ligue 1
   * scoreline that happens to be unique on the day will attach itself to an
   * English fixture and put Marseille in the Premier League. A group of the
   * wrong size cannot be that league, which rules it out before it can.
   */
  leagueSize?: (leagueId: number) => number | null;
}

const played = (f: SlotFixture): boolean => f.goalsA !== null && f.goalsB !== null;

/** The unbroken run a club is on, counting back from their latest match. */
export function currentStreak(form: Result[]): { kind: Result; length: number } | null {
  const kind = form.at(-1);
  if (!kind) return null;
  let length = 0;
  for (let i = form.length - 1; i >= 0 && form[i] === kind; i--) length++;
  return { kind, length };
}

/**
 * The slots that actually contest a competition.
 *
 * A group also carries placeholder participants — a pair standing in for a
 * rearranged fixture whose date is fixed but whose teams are not. They show up
 * with one fixture against the twenty-odd a real entrant plays, so the honest
 * cut is by workload: anything playing less than half a full card is scaffolding
 * for the calendar, not a club in the table.
 */
export function competitionSlots(fixtures: SlotFixture[], comp: number): number[] {
  const count = new Map<number, number>();
  for (const f of fixtures) {
    if (f.comp !== comp) continue;
    for (const s of [f.slotA, f.slotB]) {
      if (s === UNKNOWN_SLOT) continue;
      count.set(s, (count.get(s) ?? 0) + 1);
    }
  }
  if (!count.size) return [];
  const busiest = Math.max(...count.values());
  return [...count.entries()]
    .filter(([, n]) => n * 2 >= busiest)
    .map(([s]) => s)
    .sort((a, b) => a - b);
}

/**
 * Tie slots to clubs by matching a round-up result onto the calendar.
 *
 * A result names a slot only when exactly one fixture could be that result —
 * same date, same scoreline. Two 2-0s on one Saturday are ambiguous, and rather
 * than pick, the pass leaves them and comes back: every slot already named rules
 * itself out of the other results, so the second sweep usually has one candidate
 * where the first had three. It repeats until a sweep names nobody new.
 *
 * Anything still ambiguous when that settles stays unnamed. A wrong badge on a
 * true table would be worse than a missing one.
 */
export function anchorSlots(
  fixtures: SlotFixture[],
  results: RoundResult[],
  opts: AnchorOptions = {},
): SlotAnchor[] {
  const bySlot = new Map<string, SlotAnchor>();
  const slotOfTeam = new Map<string, number>(); // `${comp}:${teamId}` -> slot
  // A competition is one league and a league is one competition. Binding either
  // way round binds both, and nothing may cross afterwards.
  const compOfLeague = new Map<number, number>();
  const leagueOfComp = new Map<number, number>();

  const sizeOf = new Map<number, number>();
  for (const comp of new Set(fixtures.map((f) => f.comp))) {
    sizeOf.set(comp, competitionSlots(fixtures, comp).length);
  }

  const conflicts = (comp: number, slot: number, teamId: number): boolean => {
    const held = bySlot.get(`${comp}:${slot}`);
    if (held && held.teamId !== teamId) return true;
    const placed = slotOfTeam.get(`${comp}:${teamId}`);
    return placed !== undefined && placed !== slot;
  };

  const compFits = (comp: number, leagueId: number): boolean => {
    const boundComp = compOfLeague.get(leagueId);
    if (boundComp !== undefined && boundComp !== comp) return false;
    const boundLeague = leagueOfComp.get(comp);
    if (boundLeague !== undefined && boundLeague !== leagueId) return false;
    const want = opts.leagueSize?.(leagueId) ?? null;
    return want === null || sizeOf.get(comp) === want;
  };

  const take = (r: RoundResult, f: SlotFixture): void => {
    compOfLeague.set(r.leagueId, f.comp);
    leagueOfComp.set(f.comp, r.leagueId);
    for (const [slot, teamId] of [
      [f.slotA, r.homeTeamId],
      [f.slotB, r.awayTeamId],
    ] as const) {
      bySlot.set(`${f.comp}:${slot}`, { comp: f.comp, slot, teamId, namedOn: r.date });
      slotOfTeam.set(`${f.comp}:${teamId}`, slot);
    }
  };

  const pending = [...results];
  for (let sweep = 0; sweep < results.length + 1 && pending.length; sweep++) {
    let named = 0;
    for (let i = pending.length - 1; i >= 0; i--) {
      const r = pending[i]!;
      const hits = fixtures.filter(
        (f) =>
          f.date === r.date &&
          f.goalsA === r.homeGoals &&
          f.goalsB === r.awayGoals &&
          f.slotA !== UNKNOWN_SLOT &&
          f.slotB !== UNKNOWN_SLOT &&
          compFits(f.comp, r.leagueId) &&
          !conflicts(f.comp, f.slotA, r.homeTeamId) &&
          !conflicts(f.comp, f.slotB, r.awayTeamId),
      );
      if (hits.length !== 1) continue;
      take(r, hits[0]!);
      pending.splice(i, 1);
      named++;
    }
    if (!named) break;
  }

  return [...bySlot.values()];
}

/**
 * Name the last slot when only one club is left for it.
 *
 * This is deduction, not a guess: if a group has exactly as many entrants as
 * the league has clubs, and every entrant but one is already named, the one
 * that is left has nowhere else to be. It applies only at the very end, and the
 * anchor it produces carries a null date to say it was reasoned rather than
 * read.
 */
export function completeByElimination(
  fixtures: SlotFixture[],
  comp: number,
  anchors: SlotAnchor[],
  clubsInLeague: number[],
): SlotAnchor[] {
  const entrants = competitionSlots(fixtures, comp);
  if (entrants.length !== clubsInLeague.length) return anchors;

  const named = new Map(anchors.filter((a) => a.comp === comp).map((a) => [a.slot, a.teamId]));
  const missingSlots = entrants.filter((s) => !named.has(s));
  if (missingSlots.length !== 1) return anchors;

  const used = new Set(named.values());
  const missingClubs = clubsInLeague.filter((id) => !used.has(id));
  if (missingClubs.length !== 1) return anchors;

  return [...anchors, { comp, slot: missingSlots[0]!, teamId: missingClubs[0]!, namedOn: null }];
}

/** Which competition group a league's fixtures live in, per the anchors we hold. */
export function compForLeague(anchors: SlotAnchor[], leagueOfTeam: (id: number) => number | null, leagueId: number): number | null {
  for (const a of anchors) if (leagueOfTeam(a.teamId) === leagueId) return a.comp;
  return null;
}

/**
 * The table for one competition group.
 *
 * Sorted the way football sorts: points, then goal difference, then goals
 * scored. Clubs level on all three share the ordering the save happened to
 * give them, which is what the game does too.
 */
export function buildStandings(
  fixtures: SlotFixture[],
  comp: number,
  nameSlot: (slot: number) => number | null = () => null,
): Standing[] {
  const rows = new Map<number, Standing>();
  const row = (slot: number): Standing => {
    let r = rows.get(slot);
    if (!r) {
      r = {
        slot,
        teamId: nameSlot(slot),
        position: 0,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0,
        form: [],
        streak: null,
      };
      rows.set(slot, r);
    }
    return r;
  };

  const entrants = new Set(competitionSlots(fixtures, comp));
  const inComp = fixtures.filter((f) => f.comp === comp && entrants.has(f.slotA) && entrants.has(f.slotB));
  // Every entrant gets a row, even one whose season has not started.
  for (const slot of entrants) row(slot);

  for (const f of inComp.filter(played).sort((a, b) => a.date - b.date)) {
    for (const [slot, gf, ga] of [
      [f.slotA, f.goalsA!, f.goalsB!],
      [f.slotB, f.goalsB!, f.goalsA!],
    ] as const) {
      const r = row(slot);
      r.played++;
      r.goalsFor += gf;
      r.goalsAgainst += ga;
      const outcome: Result = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
      if (outcome === 'W') r.won++;
      else if (outcome === 'D') r.drawn++;
      else r.lost++;
      r.form.push(outcome);
    }
  }

  const table = [...rows.values()];
  for (const r of table) {
    r.goalDifference = r.goalsFor - r.goalsAgainst;
    r.points = r.won * 3 + r.drawn;
    r.streak = currentStreak(r.form);
    r.form = r.form.slice(-5);
  }
  table.sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor);
  table.forEach((r, i) => {
    r.position = i + 1;
  });
  return table;
}

export interface SlotMatch {
  date: number;
  kickoff: number | null;
  comp: number;
  /** True when the club whose calendar this is played at home. */
  home: boolean;
  opponentSlot: number;
  opponentTeamId: number | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
  result: Result | null;
}

/** One club's season, in date order — played matches and those still to come. */
export function fixturesForSlot(
  fixtures: SlotFixture[],
  comp: number,
  slot: number,
  nameSlot: (slot: number) => number | null = () => null,
): SlotMatch[] {
  return fixtures
    .filter((f) => f.comp === comp && (f.slotA === slot || f.slotB === slot))
    .sort((a, b) => a.date - b.date || (a.kickoff ?? 0) - (b.kickoff ?? 0))
    .map((f) => {
      const home = f.slotA === slot;
      const gf = home ? f.goalsA : f.goalsB;
      const ga = home ? f.goalsB : f.goalsA;
      const opponentSlot = home ? f.slotB : f.slotA;
      return {
        date: f.date,
        kickoff: f.kickoff,
        comp: f.comp,
        home,
        opponentSlot,
        opponentTeamId: opponentSlot === UNKNOWN_SLOT ? null : nameSlot(opponentSlot),
        goalsFor: gf,
        goalsAgainst: ga,
        result: gf === null || ga === null ? null : gf > ga ? 'W' : gf === ga ? 'D' : 'L',
      };
    });
}
