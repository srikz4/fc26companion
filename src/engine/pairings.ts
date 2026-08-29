/**
 * Naming fixture slots from who played whom.
 *
 * The results round-up (`mrni`) names a few slots a round, and only for the
 * headline leagues — some weeks it skips your division entirely. But every save
 * also carries `career_playerlastmatchhistory`: the lineup each club fielded in
 * its most recent match, with the two clubs of a match stored in neighbouring
 * blocks. That gives WHO PLAYED WHOM for the latest round, with no scoreline
 * attached and no slot numbers.
 *
 * On its own that is not enough. Put it against the calendar and it is: if a
 * pair contains a club whose slot is already known, the other club can only be
 * that slot's opponent in that round. Name it, and the next pair that touches
 * the newly named club resolves too. A handful of round-up anchors cascades
 * through a season of pairings and fills the division.
 *
 * Every step is checked. A deduction is taken only when the known club has
 * exactly one fixture in that round, and if a pairing ever contradicts a slot
 * already named, the pairing is dropped rather than the name overwritten.
 * Measured over eight rounds of a live career, 88 pairings resolved all twenty
 * clubs with no contradiction anywhere.
 */

import type { SlotFixture } from '../parser/fixtures.ts';
import type { SlotAnchor } from './standings.ts';

/** Two clubs that played each other, in the round a save was written after. */
export interface Pairing {
  /** The matchday, as the date of the latest played fixture in that save. */
  date: number;
  teamA: number;
  teamB: number;
}

interface LineupRow {
  artificialkey?: unknown;
  teamid?: unknown;
}

/**
 * Who played whom in the latest round, for one league.
 *
 * The lineup table is one block of rows per club, in match order. Blocks of
 * clubs from the league we care about are paired off two at a time; a run with
 * an odd number of clubs cannot be split unambiguously and is dropped whole.
 *
 * Pass `clubsInLeague` to make the reading all-or-nothing, which is what you
 * want for anything that will be believed. A league round is a perfect matching:
 * every club plays exactly once. If the pairs that come out are not exactly that
 * — a club appearing twice, or a division not fully covered because some clubs'
 * last match was a cup tie — then a block boundary has been misread somewhere,
 * and the safe response is to use none of it rather than to sort the good from
 * the bad by eye.
 */
export function pairingsFromLineups(
  rows: readonly LineupRow[],
  leagueOfTeam: (teamId: number) => number | null,
  leagueId: number,
  clubsInLeague?: readonly number[],
): [number, number][] {
  const ordered = rows
    .map((r) => ({
      key: typeof r.artificialkey === 'number' ? r.artificialkey : -1,
      team: typeof r.teamid === 'number' ? r.teamid : -1,
    }))
    .filter((r) => r.key >= 0 && r.team >= 0)
    .sort((a, b) => a.key - b.key);

  // Collapse each club's consecutive rows into one block.
  const blocks: { team: number; last: number }[] = [];
  for (const r of ordered) {
    const open = blocks.at(-1);
    if (open && open.team === r.team && r.key - open.last <= 2) open.last = r.key;
    else blocks.push({ team: r.team, last: r.key });
  }

  const out: [number, number][] = [];
  let run: number[] = [];
  const flush = (): void => {
    // An odd run means a block boundary we cannot place; take none of it.
    if (run.length >= 2 && run.length % 2 === 0) {
      for (let i = 0; i + 1 < run.length; i += 2) out.push([run[i]!, run[i + 1]!]);
    }
    run = [];
  };
  for (const b of blocks) {
    if (leagueOfTeam(b.team) === leagueId) run.push(b.team);
    else flush();
  }
  flush();

  if (!clubsInLeague) return out;

  const seen = new Set<number>();
  for (const [a, b] of out) {
    if (seen.has(a) || seen.has(b)) return []; // a club cannot play twice in a round
    seen.add(a);
    seen.add(b);
  }
  if (seen.size !== clubsInLeague.length) return []; // not a whole round
  for (const club of clubsInLeague) if (!seen.has(club)) return [];
  return out;
}

/** How far either side of a matchday a round's fixtures may be spread. */
const ROUND_SPAN_DAYS = 4;

/** Crude YYYYMMDD proximity — good enough to keep one round apart from the next. */
function nearby(a: number, b: number): boolean {
  if (a === b) return true;
  const y = (d: number) => Math.floor(d / 10000);
  const m = (d: number) => Math.floor((d % 10000) / 100);
  const day = (d: number) => d % 100;
  if (y(a) !== y(b)) return false;
  if (m(a) === m(b)) return Math.abs(day(a) - day(b)) <= ROUND_SPAN_DAYS;
  // Across a month boundary, allow the same span from either end.
  if (Math.abs(m(a) - m(b)) !== 1) return false;
  const [lo, hi] = m(a) < m(b) ? [a, b] : [b, a];
  return day(lo) >= 31 - ROUND_SPAN_DAYS && day(hi) <= ROUND_SPAN_DAYS;
}

export interface CascadeResult {
  anchors: SlotAnchor[];
  /** Slots named by this cascade that the anchors did not already hold. */
  learned: number;
  /** Pairings that disagreed with a slot already named, and were dropped. */
  contradictions: number;
}

/**
 * Grow a set of slot names by walking observed pairings against the calendar.
 *
 * Repeats until a pass learns nothing. Anything ambiguous — a club with more
 * than one fixture in the round, a slot already spoken for — is left alone.
 */
export function cascadeSlots(
  fixtures: SlotFixture[],
  comp: number,
  anchors: SlotAnchor[],
  pairings: Pairing[],
): CascadeResult {
  const slotOf = new Map<number, number>();
  const teamOf = new Map<number, number>();
  for (const a of anchors) {
    if (a.comp !== comp) continue;
    slotOf.set(a.teamId, a.slot);
    teamOf.set(a.slot, a.teamId);
  }
  const before = teamOf.size;
  const inComp = fixtures.filter((f) => f.comp === comp && f.goalsA !== null && f.goalsB !== null);
  const found: SlotAnchor[] = [];
  let contradictions = 0;

  for (let pass = 0; pass < pairings.length + 1; pass++) {
    let learned = 0;
    for (const p of pairings) {
      for (const [known, unknown] of [
        [p.teamA, p.teamB],
        [p.teamB, p.teamA],
      ] as const) {
        const slot = slotOf.get(known);
        if (slot === undefined || slotOf.has(unknown)) continue;
        const round = inComp.filter(
          (f) => (f.slotA === slot || f.slotB === slot) && nearby(f.date, p.date),
        );
        if (round.length !== 1) continue; // cannot say which match this was
        const other = round[0]!.slotA === slot ? round[0]!.slotB : round[0]!.slotA;
        const held = teamOf.get(other);
        if (held !== undefined) {
          if (held !== unknown) contradictions++;
          continue;
        }
        slotOf.set(unknown, other);
        teamOf.set(other, unknown);
        found.push({ comp, slot: other, teamId: unknown, namedOn: p.date });
        learned++;
      }
    }
    if (!learned) break;
  }

  return { anchors: [...anchors, ...found], learned: teamOf.size - before, contradictions };
}
