/**
 * World distributions — the statistical ground everything else stands on.
 *
 * The save carries all 21,634 players in the career's world, which means every
 * number on a card can be given context without inventing anything: "vision 88"
 * is a fact, "vision 88 — 97th percentile among centre-mids in this world" is a
 * *better* fact, computed from the same file.
 *
 * Three distributions are built once per parse:
 *
 *   - per slot, per attribute: the sorted values across every player whose
 *     primary position maps to that slot;
 *   - per age: the sorted overalls and potentials of every player of that age,
 *     which is what makes "top 1% of his generation" a measurement rather than
 *     a compliment;
 *   - per slot: mean and standard deviation per attribute, for z-scoring player
 *     profiles (the redundancy check in synergy needs comparable vectors).
 *
 * All of it is *this world's* distribution — a career three seasons in has aged
 * and grown its population, and the percentiles move with it. That is the point.
 */
import type { Row } from '../parser/dbReader.ts';
import { slotOf, type Slot } from './fit.ts';

const num = (row: Row, key: string): number | null =>
  typeof row[key] === 'number' ? (row[key] as number) : null;

/** The attributes worth ranking. Mirrors the card's six groups. */
export const RANKED_ATTRIBUTES = [
  'acceleration', 'sprintspeed', 'agility', 'balance', 'reactions',
  'ballcontrol', 'dribbling', 'positioning', 'finishing', 'shotpower',
  'longshots', 'volleys', 'penalties', 'vision', 'crossing',
  'freekickaccuracy', 'shortpassing', 'longpassing', 'curve',
  'interceptions', 'headingaccuracy', 'defensiveawareness',
  'standingtackle', 'slidingtackle', 'jumping', 'stamina', 'strength',
  'aggression', 'composure',
  'gkdiving', 'gkhandling', 'gkkicking', 'gkpositioning', 'gkreflexes',
] as const;

export interface SlotStats {
  count: number;
  /** attribute -> sorted ascending values */
  sorted: Map<string, Float64Array>;
  /** attribute -> { mean, std } for z-scoring */
  moments: Map<string, { mean: number; std: number }>;
}

export interface AgeStats {
  count: number;
  overall: Float64Array;
  potential: Float64Array;
}

export interface WorldStats {
  players: number;
  bySlot: Map<Slot, SlotStats>;
  byAge: Map<number, AgeStats>;
}

/** Share of the population at or below `value`, as 0-100. */
export function percentileOf(sorted: Float64Array, value: number): number {
  if (sorted.length === 0) return 50;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return Math.round((lo / sorted.length) * 100);
}

export function buildWorldStats(
  world: Row[],
  ageOf: (player: Row) => number | null,
): WorldStats {
  const bySlotRaw = new Map<Slot, Map<string, number[]>>();
  const byAgeRaw = new Map<number, { overall: number[]; potential: number[] }>();

  for (const player of world) {
    const slot = slotOf(num(player, 'preferredposition1'));
    if (slot) {
      let slotMap = bySlotRaw.get(slot);
      if (!slotMap) {
        slotMap = new Map();
        bySlotRaw.set(slot, slotMap);
      }
      for (const attr of RANKED_ATTRIBUTES) {
        const value = num(player, attr);
        if (value === null || value <= 0) continue;
        const list = slotMap.get(attr);
        if (list) list.push(value);
        else slotMap.set(attr, [value]);
      }
    }

    const age = ageOf(player);
    const overall = num(player, 'overallrating');
    const potential = num(player, 'potential');
    if (age !== null && overall !== null) {
      let bucket = byAgeRaw.get(age);
      if (!bucket) {
        bucket = { overall: [], potential: [] };
        byAgeRaw.set(age, bucket);
      }
      bucket.overall.push(overall);
      if (potential !== null) bucket.potential.push(potential);
    }
  }

  const bySlot = new Map<Slot, SlotStats>();
  for (const [slot, attrs] of bySlotRaw) {
    const sorted = new Map<string, Float64Array>();
    const moments = new Map<string, { mean: number; std: number }>();
    let count = 0;
    for (const [attr, values] of attrs) {
      const arr = Float64Array.from(values).sort();
      sorted.set(attr, arr);
      count = Math.max(count, arr.length);
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
      moments.set(attr, { mean, std: Math.sqrt(variance) || 1 });
    }
    bySlot.set(slot, { count, sorted, moments });
  }

  const byAge = new Map<number, AgeStats>();
  for (const [age, bucket] of byAgeRaw) {
    byAge.set(age, {
      count: bucket.overall.length,
      overall: Float64Array.from(bucket.overall).sort(),
      potential: Float64Array.from(bucket.potential).sort(),
    });
  }

  return { players: world.length, bySlot, byAge };
}

/** Percentile of one attribute value among players of the same slot. */
export function attributePercentile(
  stats: WorldStats,
  slot: Slot | null,
  attr: string,
  value: number | null,
): number | null {
  if (slot === null || value === null) return null;
  const sorted = stats.bySlot.get(slot)?.sorted.get(attr);
  if (!sorted || sorted.length < 100) return null;
  return percentileOf(sorted, value);
}

export interface AgePercentile {
  /** Percentile of the overall among the world's players of the same age. */
  overall: number;
  /** Percentile of his ceiling among the same group. */
  potential: number | null;
  peers: number;
}

/**
 * Where a player stands against his own generation.
 *
 * Ages with thin populations widen to ±1 year rather than reporting a
 * percentile computed over a handful of players.
 */
export function agePercentile(
  stats: WorldStats,
  age: number | null,
  overall: number | null,
  potential: number | null,
): AgePercentile | null {
  if (age === null || overall === null) return null;

  let bucket = stats.byAge.get(age);
  if (!bucket || bucket.count < 200) {
    const merged: number[] = [];
    const mergedPot: number[] = [];
    for (const a of [age - 1, age, age + 1]) {
      const b = stats.byAge.get(a);
      if (!b) continue;
      merged.push(...b.overall);
      mergedPot.push(...b.potential);
    }
    if (merged.length < 50) return null;
    bucket = {
      count: merged.length,
      overall: Float64Array.from(merged).sort(),
      potential: Float64Array.from(mergedPot).sort(),
    };
  }

  return {
    overall: percentileOf(bucket.overall, overall),
    potential:
      potential === null || bucket.potential.length === 0
        ? null
        : percentileOf(bucket.potential, potential),
    peers: bucket.count,
  };
}

/**
 * A player's standout attributes: the ones in the top of the position's
 * world population. These are the player's signature — the card shows
 * them so a 78-overall winger with 99th-percentile pace reads as what he is.
 */
export function standoutAttributes(
  stats: WorldStats,
  slot: Slot | null,
  player: Row,
  minPercentile = 90,
  limit = 3,
): { attr: string; value: number; percentile: number }[] {
  if (slot === null) return [];
  const slotStats = stats.bySlot.get(slot);
  if (!slotStats) return [];

  const out: { attr: string; value: number; percentile: number }[] = [];
  for (const attr of RANKED_ATTRIBUTES) {
    const value = num(player, attr);
    if (value === null || value <= 0) continue;
    const sorted = slotStats.sorted.get(attr);
    if (!sorted || sorted.length < 100) continue;
    const pct = percentileOf(sorted, value);
    if (pct >= minPercentile) out.push({ attr, value, percentile: pct });
  }
  return out.sort((a, b) => b.percentile - a.percentile || b.value - a.value).slice(0, limit);
}

/**
 * Z-scored profile vector against the slot population, for comparing two
 * players' *shapes* rather than their levels. Used by the redundancy check.
 */
export function zProfile(stats: WorldStats, slot: Slot | null, player: Row): Map<string, number> | null {
  if (slot === null) return null;
  const slotStats = stats.bySlot.get(slot);
  if (!slotStats) return null;

  const profile = new Map<string, number>();
  for (const attr of RANKED_ATTRIBUTES) {
    const value = num(player, attr);
    const m = slotStats.moments.get(attr);
    if (value === null || value <= 0 || !m) continue;
    profile.set(attr, (value - m.mean) / m.std);
  }
  return profile.size >= 10 ? profile : null;
}

/** Cosine similarity over the attributes both profiles carry. */
export function profileSimilarity(a: Map<string, number>, b: Map<string, number>): number | null {
  let dot = 0;
  let na = 0;
  let nb = 0;
  let shared = 0;
  for (const [attr, va] of a) {
    const vb = b.get(attr);
    if (vb === undefined) continue;
    shared++;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (shared < 10 || na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
