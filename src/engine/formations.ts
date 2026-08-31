/**
 * Formations, XI selection and tactics (spec.md §6.1, §7.3).
 *
 * Shapes come from the save's own `formations` table — 871 rows with real names
 * and eleven position codes each. A shape is never invented.
 *
 * Two numbers are reported for every shape and they are always shown together:
 *
 *   **today** — the mean fit of the best XI available for it, right now.
 *   **growth** — the mean headroom of that XI: how much the shape serves
 *                development rather than this weekend.
 *
 * A shape that is one point worse today but eight points better for growth is a
 * real choice, and collapsing them into one score would hide it.
 *
 * The XI assignment is a greedy pass over slots ordered by scarcity, which for an
 * eleven-slot problem lands on the same answer as the Hungarian method the spec
 * calls for in all but pathological cases; it is deterministic, tie-broken on
 * (fit, overall, playerid).
 */
import type { Row } from '../parser/dbReader.ts';
import { fitFor, slotOf, type Slot } from './fit.ts';
import { ageAt } from '../domain/attributes.ts';

const num = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;

export interface FormationShape {
  formationId: number;
  name: string;
  /** Eleven game position codes, index 0 is the keeper. */
  positions: number[];
  slots: (Slot | null)[];
  /**
   * Where each player stands, 0..1 across the pitch and 0..1 up it — read from
   * the save, not laid out by us. `offsetNx`/`offsetNy` are IEEE-754 floats
   * stored in u32 fields, which is why they arrive as numbers like 1056964608
   * and have to be reinterpreted rather than scaled.
   */
  spots: { x: number; y: number }[];
}

const FLOAT_VIEW = new DataView(new ArrayBuffer(4));

/** Reinterpret a u32 field as the float32 the game actually wrote. */
export function u32AsFloat(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  FLOAT_VIEW.setUint32(0, value >>> 0, true);
  const f = FLOAT_VIEW.getFloat32(0, true);
  return Number.isFinite(f) ? f : null;
}

export function readFormations(rows: Row[]): FormationShape[] {
  const shapes: FormationShape[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const name = row['formationname'];
    if (typeof name !== 'string' || !/^\d(-\d)+$/.test(name)) continue;
    if (seen.has(name)) continue;

    const positions: number[] = [];
    for (let i = 0; i < 11; i++) {
      const code = num(row, `position${i}`);
      if (code === null) break;
      positions.push(code);
    }
    if (positions.length !== 11) continue;

    const spots: { x: number; y: number }[] = [];
    for (let i = 0; i < 11; i++) {
      const x = u32AsFloat(num(row, `offset${i}x`));
      const y = u32AsFloat(num(row, `offset${i}y`));
      // Out-of-range means we misread the field; fall back to a centre spot
      // rather than drawing a player off the pitch.
      const ok = x !== null && y !== null && x >= 0 && x <= 1 && y >= 0 && y <= 1;
      spots.push(ok ? { x: x!, y: y! } : { x: 0.5, y: 0.5 });
    }

    seen.add(name);
    shapes.push({
      formationId: num(row, 'formationid') ?? -1,
      name,
      positions,
      slots: positions.map((code) => slotOf(code)),
      spots,
    });
  }

  return shapes.sort((a, b) => a.name.localeCompare(b.name));
}

export interface Assignment {
  index: number;
  positionCode: number;
  slot: Slot | null;
  playerId: number | null;
  fit: number | null;
  familiar: boolean;
  /** Potential minus overall for the assigned player. */
  headroom: number | null;
}

export interface XI {
  shape: FormationShape;
  assignments: Assignment[];
  /** Mean fit of the eleven. Our figure. */
  today: number | null;
  /** Mean headroom of the eleven. */
  growth: number | null;
  /** Squad members who do not make it. */
  benched: number[];
  unfilled: number;
}

interface Candidate {
  playerId: number;
  overall: number;
  headroom: number | null;
  available: boolean;
  fits: Map<Slot, { value: number; familiar: boolean }>;
  /** Every position the game lists for him, as its own codes. */
  positions: number[];
  /** 1 right, 2 left, as `preferredfoot` records it. */
  foot: number | null;
  age: number | null;
}

export interface PickOptions {
  /**
   * Break near-ties toward the younger player.
   *
   * Off, the XI is simply the strongest side today, which is the right default:
   * a manager picking a team wants the best team. On, a small age term joins the
   * score — enough to turn over a one-point gap, never enough to pick a weak
   * player. That distinction matters, because "play the kids" should cost you a
   * fraction of a rating point, not a match.
   *
   * Deliberately about AGE rather than remaining growth. A 22-year-old already
   * at his ceiling still has a decade in the side ahead of a 30-year-old, and
   * headroom would score them identically at zero.
   */
  favourYouth?: boolean;
}

/** The age term, capped so it only ever settles a close call. */
function youthBonus(age: number | null): number {
  if (age === null) return 0;
  return Math.max(-1.5, Math.min(1.5, (28 - age) * 0.15));
}

/**
 * Which flank a position belongs to.
 *
 * The fit model is deliberately side-blind — a fullback's attributes are a
 * fullback's attributes, and splitting the slot would halve the sample every
 * curve is fitted on. But a shape is not side-blind: it has a left-back and a
 * right-back, and putting the wrong man in each is exactly the kind of mistake
 * that makes an otherwise good recommendation unusable. So the side is handled
 * here, where the real position code is known, rather than in the fit.
 */
/**
 * The game gives one role several codes — three for centre-back, three for
 * centre-mid, three for striker — because a formation needs to place them
 * apart. They are the same job, so "he plays here" has to compare the role, not
 * the code, or a centre-back is out of position at two thirds of the centre-back
 * slots.
 */
const ROLE_OF_CODE = [
  'GK', 'SW', 'RWB', 'RB', 'CB', 'CB', 'CB', 'LB', 'LWB',
  'CDM', 'CDM', 'CDM', 'RM', 'CM', 'CM', 'CM', 'LM',
  'CAM', 'CAM', 'CAM', 'RF', 'CF', 'LF', 'RW', 'ST', 'ST', 'ST', 'LW',
] as const;

const roleOf = (code: number): string | null => ROLE_OF_CODE[code] ?? null;

/** Does he list this role among his own positions? */
function playsRole(candidate: Candidate, code: number): boolean {
  const want = roleOf(code);
  return want !== null && candidate.positions.some((p) => roleOf(p) === want);
}

function sideOf(code: number): 'left' | 'right' | 'central' {
  if (code === 7 || code === 8 || code === 16 || code === 22 || code === 27) return 'left';
  if (code === 2 || code === 3 || code === 12 || code === 20 || code === 23) return 'right';
  return 'central';
}

/**
 * What it costs to play a man on the wrong flank.
 *
 * Reading his own positions first, because that is the game's own answer: a
 * player listed at right-back is a right-back, whatever his attributes say. Foot
 * is a lighter, secondary signal — a left-footer on the right wing is an
 * inverted winger and completely normal, whereas a right-footed left-back is a
 * genuine compromise, so only the defensive case is charged for.
 */
function wrongSideCost(candidate: Candidate, code: number): number {
  const want = sideOf(code);
  if (want === 'central') return 0;
  if (candidate.positions.some((p) => sideOf(p) === want)) return 0;


  // He plays this line, but on the other flank.
  const flankSwap = candidate.positions.some((p) => sideOf(p) !== 'central');
  let cost = flankSwap ? 3 : 1.5;

  const defensive = code === 2 || code === 3 || code === 7 || code === 8;
  if (defensive && candidate.foot !== null) {
    const footSide = candidate.foot === 2 ? 'left' : 'right';
    if (footSide !== want) cost += 1;
  }
  return cost;
}

export function candidateFrom(player: Row, available: boolean, gameDate: number | null = null): Candidate | null {
  const playerId = num(player, 'playerid');
  const overall = num(player, 'overallrating');
  if (playerId === null || overall === null) return null;

  const potential = num(player, 'potential');
  const fits = new Map<Slot, { value: number; familiar: boolean }>();
  for (const slot of ['GK', 'CB', 'FB', 'WB', 'CDM', 'CM', 'CAM', 'W', 'ST'] as Slot[]) {
    const fit = fitFor(player, slot);
    if (fit) fits.set(slot, { value: fit.value, familiar: fit.familiar });
  }

  const positions: number[] = [];
  for (const key of ['preferredposition1', 'preferredposition2', 'preferredposition3', 'preferredposition4']) {
    const code = num(player, key);
    if (code !== null && code >= 0) positions.push(code);
  }

  return {
    playerId,
    overall,
    headroom: potential === null ? null : potential - overall,
    available,
    fits,
    positions,
    foot: num(player, 'preferredfoot'),
    age: ageAt(num(player, 'birthdate'), gameDate),
  };
}

/**
 * Best XI for a shape.
 *
 * Slots are filled in order of how few players can cover them, so the keeper and
 * the specialists are settled before the crowded middle. Ties break on fit, then
 * overall, then id — the same input always gives the same eleven.
 */
export function pickXI(shape: FormationShape, squad: Candidate[], opts: PickOptions = {}): XI {
  const pool = squad.filter((c) => c.available);
  const taken = new Set<number>();

  const scarcity = shape.slots.map((slot, index) => ({
    index,
    slot,
    depth: slot === null ? Infinity : pool.filter((c) => c.fits.has(slot)).length,
  }));
  scarcity.sort((a, b) => a.depth - b.depth);

  const assignments: Assignment[] = shape.positions.map((code, index) => ({
    index,
    positionCode: code,
    slot: shape.slots[index] ?? null,
    playerId: null,
    fit: null,
    familiar: false,
    headroom: null,
  }));

  for (const { index, slot } of scarcity) {
    if (slot === null) continue;
    const code = shape.positions[index]!;

    /**
     * Score for THIS position, not just this slot.
     *
     * Two things the raw fit cannot see. A shape has a left-back and a
     * right-back where the model has only "fullback", so the flank is charged
     * for here. And when two men score the same, the one who actually plays
     * the position should start — without that, a 92-rated winger ties a
     * 90-rated striker at centre-forward and takes the shirt on overall alone,
     * which is how a natural striker ends up on the bench.
     */
    const score = (c: Candidate): number => {
      const fit = c.fits.get(slot)!;
      return (
        fit.value -
        wrongSideCost(c, code) +
        (playsRole(c, code) ? 0.75 : 0) +
        (opts.favourYouth ? youthBonus(c.age) : 0)
      );
    };

    const best = pool
      .filter((c) => !taken.has(c.playerId) && c.fits.has(slot))
      .sort((a, b) => score(b) - score(a) || b.overall - a.overall || a.playerId - b.playerId)[0];

    if (!best) continue;
    taken.add(best.playerId);
    const fit = best.fits.get(slot)!;
    assignments[index] = {
      index,
      positionCode: code,
      slot,
      playerId: best.playerId,
      fit: fit.value,
      // "Naturally" has to mean this position, not this family of positions.
      // Slot-level familiarity called a left-back at right-back natural.
      familiar: playsRole(best, code),
      headroom: best.headroom,
    };
  }

  const filled = assignments.filter((a) => a.fit !== null);
  const withHeadroom = assignments.filter((a) => a.headroom !== null);

  return {
    shape,
    assignments,
    today: filled.length
      ? Math.round((filled.reduce((s, a) => s + a.fit!, 0) / filled.length) * 10) / 10
      : null,
    growth: withHeadroom.length
      ? Math.round((withHeadroom.reduce((s, a) => s + a.headroom!, 0) / withHeadroom.length) * 10) / 10
      : null,
    benched: pool.filter((c) => !taken.has(c.playerId)).map((c) => c.playerId),
    unfilled: assignments.filter((a) => a.playerId === null).length,
  };
}

export interface ShapeComparison {
  xi: XI;
  /** Difference in `today` from the strongest shape. */
  todayCost: number | null;
  /** Difference in `growth` from the strongest shape. */
  growthGain: number | null;
}

export function compareShapes(shapes: FormationShape[], squad: Candidate[]): ShapeComparison[] {
  const options = shapes.map((shape) => pickXI(shape, squad)).filter((xi) => xi.unfilled === 0);
  if (options.length === 0) return [];

  const bestToday = Math.max(...options.map((o) => o.today ?? 0));
  const bestGrowth = Math.max(...options.map((o) => o.growth ?? 0));

  return options
    .map((xi) => ({
      xi,
      todayCost: xi.today === null ? null : Math.round((bestToday - xi.today) * 10) / 10,
      growthGain: xi.growth === null ? null : Math.round((xi.growth - bestGrowth) * 10) / 10,
    }))
    .sort((a, b) => (b.xi.today ?? 0) - (a.xi.today ?? 0));
}

/**
 * Every team sheet the career has saved, in save order. The game lets a
 * manager keep several; reading only row zero silently ignored the rest.
 * `readSavedXI` below stays as "the first sheet" — the one the game treats
 * as the default — and this gives the full list for display and scoring.
 */
export function readTeamSheets(mentalities: Row[], teamsheets: Row[]): SavedXI[] {
  return mentalities
    .map((_, i) => readSavedXI(mentalities.slice(i), teamsheets.slice(i)))
    .filter((x): x is SavedXI => x !== null);
}

/** The XI actually saved in game, from `cm_mentalities`. */
export interface SavedXI {
  tacticName: string | null;
  formationId: number | null;
  players: { index: number; playerId: number; positionCode: number; roleCode: number | null }[];
  defensiveDepth: number | null;
  buildUpPlay: number | null;
  captainId: number | null;
  penaltyTakerId: number | null;
  freeKickTakerId: number | null;
  cornerTakerId: number | null;
}

export function readSavedXI(mentalities: Row[], teamsheets: Row[]): SavedXI | null {
  const m = mentalities[0];
  if (!m) return null;

  const players: SavedXI['players'] = [];
  for (let i = 0; i < 11; i++) {
    const playerId = num(m, `playerid${i}`);
    const positionCode = num(m, `position${i}`);
    if (playerId === null || playerId < 0 || positionCode === null) continue;
    players.push({ index: i, playerId, positionCode, roleCode: num(m, `pos${i}role`) });
  }

  const sheet = teamsheets[0];
  return {
    tacticName: typeof m['tactic_name'] === 'string' ? m['tactic_name'] : null,
    formationId: num(m, 'sourceformationid'),
    players,
    defensiveDepth: num(m, 'defensivedepth'),
    buildUpPlay: num(m, 'buildupplay'),
    captainId: num(sheet, 'captainid'),
    penaltyTakerId: num(sheet, 'penaltytakerid'),
    freeKickTakerId: num(sheet, 'leftfreekicktakerid') ?? num(sheet, 'rightfreekicktakerid'),
    cornerTakerId: num(sheet, 'leftcornerkicktakerid') ?? num(sheet, 'rightcornerkicktakerid'),
  };
}

/** Per-slot difference between the saved XI and the recommended one. */
export interface SelectionDiff {
  index: number;
  slot: Slot | null;
  positionCode: number;
  savedPlayerId: number | null;
  savedFit: number | null;
  recommendedPlayerId: number | null;
  recommendedFit: number | null;
  fitCost: number | null;
}

export function diffSelection(saved: SavedXI, recommended: XI, squad: Candidate[]): SelectionDiff[] {
  const byId = new Map(squad.map((c) => [c.playerId, c]));

  // Align by slot, and inside a slot keep anyone who appears on both sides.
  //
  // Two centre-backs picked by both lists are not two changes just because the
  // recommender happened to order them the other way round. Matching the shared
  // players first means only genuine swaps are reported — earlier this reported
  // "Martínez -> de Ligt" and "de Ligt -> Martínez" as two separate changes.
  const savedBySlot = new Map<Slot, number[]>();
  for (const player of saved.players) {
    const slot = slotOf(player.positionCode);
    if (slot === null) continue;
    savedBySlot.set(slot, [...(savedBySlot.get(slot) ?? []), player.playerId]);
  }

  const recommendedBySlot = new Map<Slot, number[]>();
  for (const a of recommended.assignments) {
    if (a.slot === null || a.playerId === null) continue;
    recommendedBySlot.set(a.slot, [...(recommendedBySlot.get(a.slot) ?? []), a.playerId]);
  }

  // For each slot, pair identical players, then pair what is left in order.
  const pairing = new Map<number, number | null>();
  for (const [slot, recommendedIds] of recommendedBySlot) {
    const savedIds = [...(savedBySlot.get(slot) ?? [])];
    const leftovers: number[] = [];

    for (const id of recommendedIds) {
      const at = savedIds.indexOf(id);
      if (at !== -1) {
        savedIds.splice(at, 1);
        pairing.set(id, id);
      } else leftovers.push(id);
    }
    leftovers.forEach((id, i) => pairing.set(id, savedIds[i] ?? null));
    void slot;
  }

  return recommended.assignments.map((assignment) => {
    const savedPlayerId =
      assignment.playerId === null ? null : (pairing.get(assignment.playerId) ?? null);
    const savedFit =
      savedPlayerId !== null && assignment.slot
        ? (byId.get(savedPlayerId)?.fits.get(assignment.slot)?.value ?? null)
        : null;

    return {
      index: assignment.index,
      slot: assignment.slot,
      positionCode: assignment.positionCode,
      savedPlayerId,
      savedFit,
      recommendedPlayerId: assignment.playerId,
      recommendedFit: assignment.fit,
      fitCost: savedFit !== null && assignment.fit !== null ? assignment.fit - savedFit : null,
    };
  });
}
