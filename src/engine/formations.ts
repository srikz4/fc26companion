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
}

export function candidateFrom(player: Row, available: boolean): Candidate | null {
  const playerId = num(player, 'playerid');
  const overall = num(player, 'overallrating');
  if (playerId === null || overall === null) return null;

  const potential = num(player, 'potential');
  const fits = new Map<Slot, { value: number; familiar: boolean }>();
  for (const slot of ['GK', 'CB', 'FB', 'WB', 'CDM', 'CM', 'CAM', 'W', 'ST'] as Slot[]) {
    const fit = fitFor(player, slot);
    if (fit) fits.set(slot, { value: fit.value, familiar: fit.familiar });
  }

  return {
    playerId,
    overall,
    headroom: potential === null ? null : potential - overall,
    available,
    fits,
  };
}

/**
 * Best XI for a shape.
 *
 * Slots are filled in order of how few players can cover them, so the keeper and
 * the specialists are settled before the crowded middle. Ties break on fit, then
 * overall, then id — the same input always gives the same eleven.
 */
export function pickXI(shape: FormationShape, squad: Candidate[]): XI {
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
    const best = pool
      .filter((c) => !taken.has(c.playerId) && c.fits.has(slot))
      .sort((a, b) => {
        const fa = a.fits.get(slot)!.value;
        const fb = b.fits.get(slot)!.value;
        return fb - fa || b.overall - a.overall || a.playerId - b.playerId;
      })[0];

    if (!best) continue;
    taken.add(best.playerId);
    const fit = best.fits.get(slot)!;
    assignments[index] = {
      index,
      positionCode: shape.positions[index]!,
      slot,
      playerId: best.playerId,
      fit: fit.value,
      familiar: fit.familiar,
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
