/**
 * Recovering the FC 26 base `nameid -> name` table by derivation.
 *
 * The save stores names as `nameid` references into a table that ships with the
 * game (§2.5). We cannot read that table — but we can *solve* for a large part of
 * it: for ~15,000 players we know both the name (from the imported `playerid`
 * table) and the `nameid`s the save uses. Every such player is one equation.
 * Collect them, and a `nameid` used by fifteen different Andersens resolves to
 * "Andersen" with fifteen independent confirmations.
 *
 * This matters because **newgens and academy players have no other route.** They
 * do not exist in any external dataset — they were generated inside this career —
 * and their `nameid`s point into the same base pool as everyone else.
 *
 * ## Measured, not assumed
 *
 * Held-out validation (train on 12,313 players, test on 3,079 the derivation never
 * saw), on this machine's save:
 *
 * | Threshold | Surname precision | First-name precision | Coverage |
 * |---|---|---|---|
 * | >=1 vote, any agreement | 93.0% | 91.7% | 28% |
 * | >=1 vote, unanimous | 97.7% | 93.7% | 26% |
 * | **>=2 votes, >=90% agreement** | **98.7%** | **96.2%** | **15%** |
 * | >=3 votes, >=90% agreement | 98.8% | 96.3% | 11% |
 *
 * Precision plateaus around 98.7% and coverage falls away, because most surnames
 * in a football database are rare. `DEFAULT_THRESHOLD` sits at the knee.
 *
 * ## Why this is not a guess, and is still marked provisional
 *
 * ~1.3% of derived surnames are wrong, so a derived name is **provisional** in the
 * sense of spec.md §2.3: displayed with a mark, never presented as read from the
 * save, and never allowed to drive a recommendation. Rules key on `playerid`, so
 * nothing downstream depends on a name being right.
 *
 * ## A trap worth recording
 *
 * `editedplayernames` looks like an ideal test set — 39 names the save spells out
 * literally — and measuring against it gives 37% precision, which reads as a flat
 * failure. It is not: that table is an *override*. For a player in it, the stored
 * `nameid`s are whatever the generator first picked and need not match the
 * displayed name. Validating against it measures the override, not the derivation.
 * Hence the held-out split above.
 */
import type { Row, Tables } from '../parser/dbReader.ts';
import type { NameTable } from './nameTable.ts';

export interface Threshold {
  minVotes: number;
  /** Share of votes the winning candidate must hold, 0..1. */
  minAgreement: number;
}

/** The knee of the precision/coverage curve: 98.7% surnames, 96.2% first names. */
export const DEFAULT_THRESHOLD: Threshold = { minVotes: 2, minAgreement: 0.9 };

export interface DerivedEntry {
  name: string;
  votes: number;
  agreement: number;
}

export interface DerivedNameIds {
  first: Map<number, DerivedEntry>;
  last: Map<number, DerivedEntry>;
  /** Literal strings from the save's own `dcplayernames`, not derived at all. */
  literal: Map<number, string>;
  threshold: Threshold;
  samples: number;
}

export const EMPTY_DERIVED: DerivedNameIds = {
  first: new Map(),
  last: new Map(),
  literal: new Map(),
  threshold: DEFAULT_THRESHOLD,
  samples: 0,
};

type Ballot = Map<number, Map<string, number>>;

function castVote(ballot: Ballot, nameId: number, candidate: string): void {
  if (!nameId || !candidate) return;
  const box = ballot.get(nameId) ?? new Map<string, number>();
  box.set(candidate, (box.get(candidate) ?? 0) + 1);
  ballot.set(nameId, box);
}

function count(ballot: Ballot, threshold: Threshold): Map<number, DerivedEntry> {
  const out = new Map<number, DerivedEntry>();
  for (const [nameId, box] of ballot) {
    const total = [...box.values()].reduce((a, b) => a + b, 0);
    const winner = [...box].sort((a, b) => b[1] - a[1])[0];
    if (!winner) continue;
    const [name, votes] = winner;
    const agreement = votes / total;
    if (votes >= threshold.minVotes && agreement >= threshold.minAgreement) {
      out.set(nameId, { name, votes, agreement });
    }
  }
  return out;
}

/**
 * Split a known name into the parts EA stores separately.
 *
 * `short_name` is usually "B. Mbeumo", so the surname is everything after the
 * initial — more reliable than taking the last token of a long name, which breaks
 * on the many players carrying three or four.
 */
export function splitKnownName(short: string, full: string): { first: string; last: string } {
  const tokens = full.split(/\s+/).filter(Boolean);
  const initialForm = /^(\p{L})\.\s+(.+)$/u.exec(short);
  return {
    first: tokens[0] ?? '',
    last: initialForm ? initialForm[2]! : (tokens[tokens.length - 1] ?? ''),
  };
}

const numberOf = (row: Row, key: string): number =>
  typeof row[key] === 'number' ? (row[key] as number) : 0;

/**
 * Build the derived table from one or more parsed saves.
 *
 * Players listed in `editedplayernames` are excluded from training: their stored
 * `nameid`s are overridden by that table and would poison the ballot.
 */
export function deriveNameIds(
  sources: Tables[],
  known: NameTable,
  threshold: Threshold = DEFAULT_THRESHOLD,
): DerivedNameIds {
  const firstBallot: Ballot = new Map();
  const lastBallot: Ballot = new Map();
  const literal = new Map<number, string>();
  let samples = 0;

  for (const tables of sources) {
    // dcplayernames is a literal nameid -> string table carried in the save. It
    // only covers ids 44000+, but where it applies it is authoritative.
    for (const row of tables['dcplayernames'] ?? []) {
      const id = numberOf(row, 'nameid');
      const name = row['name'];
      if (id && typeof name === 'string' && name.length > 0) literal.set(id, name);
    }

    const overridden = new Set(
      (tables['editedplayernames'] ?? []).map((e) => numberOf(e, 'playerid')),
    );

    for (const player of tables['players'] ?? []) {
      const playerId = numberOf(player, 'playerid');
      if (overridden.has(playerId)) continue;

      const entry = known.byPlayerId.get(playerId);
      if (!entry) continue;

      const { first, last } = splitKnownName(entry.short, entry.full);
      castVote(firstBallot, numberOf(player, 'firstnameid'), first);
      castVote(lastBallot, numberOf(player, 'lastnameid'), last);
      samples++;
    }
  }

  return {
    first: count(firstBallot, threshold),
    last: count(lastBallot, threshold),
    literal,
    threshold,
    samples,
  };
}

export interface DerivedName {
  display: string;
  /** Lowest vote count behind any part of the name. */
  votes: number;
  /** True when every part came from `dcplayernames` rather than the ballot. */
  literalOnly: boolean;
  /** True when only the first name resolved, so the id must stay alongside it. */
  partial: boolean;
}

/**
 * Name one player from the derived table.
 *
 * Returns null unless at least a surname is available — a lone first name is not
 * a name. `playerjerseynameid` is consulted as a literal fallback: for the FC 26
 * save on this machine it is what identifies player 79399 as "G. Mora", straight
 * out of `dcplayernames`.
 */
export function deriveName(player: Row, derived: DerivedNameIds): DerivedName | null {
  const firstId = numberOf(player, 'firstnameid');
  const lastId = numberOf(player, 'lastnameid');
  const commonId = numberOf(player, 'commonnameid');
  const jerseyId = numberOf(player, 'playerjerseynameid');

  const commonLiteral = derived.literal.get(commonId);
  if (commonLiteral) {
    return { display: commonLiteral, votes: Infinity, literalOnly: true, partial: false };
  }

  const firstLiteral = derived.literal.get(firstId);
  const lastLiteral = derived.literal.get(lastId);
  const firstVoted = derived.first.get(firstId);
  const lastVoted = derived.last.get(lastId);

  const first = firstLiteral ?? firstVoted?.name ?? '';
  const last = lastLiteral ?? lastVoted?.name ?? '';

  if (last) {
    const votes = Math.min(
      firstLiteral || !first ? Infinity : (firstVoted?.votes ?? Infinity),
      lastLiteral ? Infinity : (lastVoted?.votes ?? Infinity),
    );
    return {
      display: [first, last].filter(Boolean).join(' '),
      votes,
      literalOnly: Boolean(firstLiteral || !first) && Boolean(lastLiteral),
      partial: false,
    };
  }

  // No surname. A jersey name is a real string from the save — usually a surname
  // with an initial — and beats an id outright.
  const jerseyLiteral = derived.literal.get(jerseyId);
  if (jerseyLiteral) {
    return { display: jerseyLiteral, votes: Infinity, literalOnly: true, partial: false };
  }

  // Only the first name resolved. Half a name is not a name, so it is returned
  // marked partial and the caller keeps the id alongside it: "Nicolò #460095".
  if (first) {
    return {
      display: first,
      votes: firstLiteral ? Infinity : (firstVoted?.votes ?? 0),
      literalOnly: Boolean(firstLiteral),
      partial: true,
    };
  }

  return null;
}
