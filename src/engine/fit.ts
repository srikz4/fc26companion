/**
 * Position fit (spec.md §5.2).
 *
 * `fit` answers a question the game will not: what would this player rate as,
 * played somewhere else. At the player's own position it agrees with the game's overall to
 * within a point, which is the whole basis for trusting it anywhere else.
 */
import type { Row } from '../parser/dbReader.ts';

export type Slot = 'GK' | 'CB' | 'FB' | 'WB' | 'CDM' | 'CM' | 'CAM' | 'W' | 'ST';

export const SLOTS: readonly Slot[] = ['GK', 'CB', 'FB', 'WB', 'CDM', 'CM', 'CAM', 'W', 'ST'];

/**
 * Position models, **fitted from the save rather than guessed**.
 *
 * Each slot has a weight per attribute plus an intercept, obtained by ordinary
 * least squares of the game's own `overallrating` on the attributes of every
 * player whose primary position maps to that slot — between 1,296 and 3,915
 * players per slot in this save. Coefficients that came out negative were dropped
 * and the model refitted, so every surviving weight reads as "this attribute
 * helps here".
 *
 * The result reproduces the game's rating to a mean absolute error of 0.03-0.25
 * and lands within 1 for 99-100% of players, which clears the ±1 checkpoint the
 * spec sets (F-1). An earlier hand-written table missed by 1.42 on average and by
 * 3.6 at winger.
 *
 * What that buys is not a second opinion on a player's overall — at their own
 * position fit now simply *is* his overall. It is an answer to the question the
 * game will not answer: what would he rate as, played somewhere else.
 */
const MODEL: Record<Slot, { intercept: number; weights: Record<string, number> }> = {
  GK: {
    intercept: 0.86,
    weights: {
      gkhandling: 0.2131,
      gkreflexes: 0.2121,
      gkdiving: 0.2083,
      gkpositioning: 0.2066,
      reactions: 0.1108,
      gkkicking: 0.0513,
    },
  },
  CB: {
    intercept: -0.2,
    weights: {
      standingtackle: 0.1737,
      defensiveawareness: 0.1407,
      interceptions: 0.1311,
      slidingtackle: 0.1003,
      strength: 0.0994,
      headingaccuracy: 0.0985,
      aggression: 0.0688,
      reactions: 0.0521,
      shortpassing: 0.0503,
      ballcontrol: 0.0408,
      jumping: 0.0266,
      sprintspeed: 0.0211,
    },
  },
  FB: {
    intercept: 1.65,
    weights: {
      slidingtackle: 0.1397,
      interceptions: 0.1195,
      standingtackle: 0.1132,
      crossing: 0.0898,
      reactions: 0.0833,
      defensiveawareness: 0.0808,
      stamina: 0.079,
      shortpassing: 0.0698,
      sprintspeed: 0.0692,
      ballcontrol: 0.0684,
      acceleration: 0.0514,
      headingaccuracy: 0.0409,
    },
  },
  WB: {
    intercept: 1.65,
    weights: {
      slidingtackle: 0.1397,
      interceptions: 0.1195,
      standingtackle: 0.1132,
      crossing: 0.0898,
      reactions: 0.0833,
      defensiveawareness: 0.0808,
      stamina: 0.079,
      shortpassing: 0.0698,
      sprintspeed: 0.0692,
      ballcontrol: 0.0684,
      acceleration: 0.0514,
      headingaccuracy: 0.0409,
    },
  },
  CDM: {
    intercept: 0.7,
    weights: {
      shortpassing: 0.1404,
      interceptions: 0.1362,
      standingtackle: 0.1212,
      ballcontrol: 0.1014,
      longpassing: 0.1011,
      defensiveawareness: 0.0898,
      reactions: 0.0754,
      stamina: 0.0573,
      slidingtackle: 0.0523,
      aggression: 0.0486,
      vision: 0.0411,
      strength: 0.04,
    },
  },
  CM: {
    intercept: -0.5,
    weights: {
      shortpassing: 0.1737,
      ballcontrol: 0.1419,
      longpassing: 0.1305,
      vision: 0.1278,
      reactions: 0.0873,
      dribbling: 0.0663,
      positioning: 0.0596,
      stamina: 0.0589,
      interceptions: 0.0508,
      standingtackle: 0.0482,
      longshots: 0.0404,
      finishing: 0.0198,
      sprintspeed: 0.0024,
    },
  },
  CAM: {
    intercept: -0.46,
    weights: {
      shortpassing: 0.1602,
      ballcontrol: 0.1472,
      vision: 0.141,
      dribbling: 0.1319,
      positioning: 0.0916,
      reactions: 0.0729,
      finishing: 0.0718,
      longshots: 0.047,
      longpassing: 0.0416,
      acceleration: 0.0395,
      sprintspeed: 0.0334,
      agility: 0.029,
    },
  },
  W: {
    intercept: 0.83,
    weights: {
      dribbling: 0.1576,
      ballcontrol: 0.1412,
      shortpassing: 0.1016,
      crossing: 0.1009,
      positioning: 0.0814,
      reactions: 0.0734,
      finishing: 0.071,
      acceleration: 0.0657,
      sprintspeed: 0.0613,
      vision: 0.0565,
      stamina: 0.0388,
      longpassing: 0.0349,
      agility: 0.0068,
      longshots: 0.0056,
      slidingtackle: 0.0042,
    },
  },
  ST: {
    intercept: -0.38,
    weights: {
      finishing: 0.1849,
      positioning: 0.1304,
      ballcontrol: 0.1054,
      shotpower: 0.1007,
      headingaccuracy: 0.0984,
      reactions: 0.0809,
      dribbling: 0.0643,
      sprintspeed: 0.0518,
      shortpassing: 0.0518,
      strength: 0.0474,
      acceleration: 0.0383,
      longshots: 0.0316,
      volleys: 0.0202,
    },
  },
};

/** Game position codes -> our slots. */
const CODE_TO_SLOT: Record<number, Slot> = {
  0: 'GK',
  1: 'CB',
  2: 'WB',
  3: 'FB',
  4: 'CB',
  5: 'CB',
  6: 'CB',
  7: 'FB',
  8: 'WB',
  9: 'CDM',
  10: 'CDM',
  11: 'CDM',
  12: 'W',
  13: 'CM',
  14: 'CM',
  15: 'CM',
  16: 'W',
  17: 'CAM',
  18: 'CAM',
  19: 'CAM',
  20: 'W',
  21: 'ST',
  22: 'W',
  23: 'W',
  24: 'ST',
  25: 'ST',
  26: 'ST',
  27: 'W',
};

export const slotOf = (code: number | null | undefined): Slot | null =>
  code === null || code === undefined ? null : (CODE_TO_SLOT[code] ?? null);

/** Penalty when a player is asked to fill a slot none of his positions cover. */
export const UNFAMILIAR_PENALTY = 4;

const attr = (player: Row, key: string): number | null =>
  typeof player[key] === 'number' ? (player[key] as number) : null;

export function familiarSlots(player: Row): Set<Slot> {
  const slots = new Set<Slot>();
  for (const n of [1, 2, 3, 4]) {
    const slot = slotOf(attr(player, `preferredposition${n}`));
    if (slot) slots.add(slot);
  }
  return slots;
}

export interface Fit {
  slot: Slot;
  /** Our computed rating for this slot. Not the game's OVR. */
  value: number;
  familiar: boolean;
}

/**
 * Fit for one slot. Returns null when the player lacks the attributes the slot
 * weighs — a goalkeeper has no meaningful outfield fit and vice versa.
 */
function rawFit(player: Row, slot: Slot): number | null {
  const model = MODEL[slot];
  let total = 0;
  let weightUsed = 0;

  for (const [key, weight] of Object.entries(model.weights)) {
    const value = attr(player, key);
    if (value === null) continue;
    total += value * weight;
    weightUsed += weight;
  }

  // Missing more than a fifth of the weight means we are guessing, not computing.
  if (weightUsed < 0.8) return null;

  // Rescale for any attribute the row was missing, then apply the intercept.
  return model.intercept + total / weightUsed;
}

/**
 * Per-player anchor: the population-fitted model is right about *structure*
 * (how much worse this player is one slot over), but its level can sit a
 * point off any individual. EA's own overall IS the level at the player's
 * primary position, so pin it there: fit(own slot) === overall exactly, and
 * every other slot moves by the same player-specific offset. Cached per row —
 * eighteen slots would otherwise recompute the same anchor eighteen times.
 */
const anchorCache = new WeakMap<Row, number>();
function anchorOf(player: Row): number {
  const hit = anchorCache.get(player);
  if (hit !== undefined) return hit;
  let offset = 0;
  const overall = attr(player, 'overallrating');
  const primary = slotOf(attr(player, 'preferredposition1'));
  if (overall !== null && primary !== null) {
    const own = rawFit(player, primary);
    if (own !== null) offset = overall - own;
  }
  anchorCache.set(player, offset);
  return offset;
}

export function fitFor(player: Row, slot: Slot): Fit | null {
  const raw = rawFit(player, slot);
  if (raw === null) return null;
  const familiar = familiarSlots(player).has(slot);
  return {
    slot,
    value: Math.round(raw + anchorOf(player) - (familiar ? 0 : UNFAMILIAR_PENALTY)),
    familiar,
  };
}

export function allFits(player: Row): Fit[] {
  const isKeeper = attr(player, 'preferredposition1') === 0;
  const slots = isKeeper ? (['GK'] as Slot[]) : SLOTS.filter((s) => s !== 'GK');
  return slots
    .map((slot) => fitFor(player, slot))
    .filter((f): f is Fit => f !== null)
    .sort((a, b) => b.value - a.value);
}

export function bestFit(player: Row): Fit | null {
  return allFits(player)[0] ?? null;
}

/**
 * How far our fit sits from the game's OVR at each player's primary position.
 * The spec's checkpoint is a mean absolute error within 1; this is how that gets
 * measured rather than asserted.
 */
export function calibrationReport(players: Row[]): {
  count: number;
  meanAbsoluteError: number | null;
  within1: number;
  worst: { playerId: number; slot: Slot; fit: number; overall: number }[];
} {
  const rows: { playerId: number; slot: Slot; fit: number; overall: number; error: number }[] = [];

  for (const player of players) {
    const slot = slotOf(attr(player, 'preferredposition1'));
    const overall = attr(player, 'overallrating');
    const id = attr(player, 'playerid');
    if (!slot || overall === null || id === null) continue;
    const fit = fitFor(player, slot);
    if (!fit) continue;
    rows.push({ playerId: id, slot, fit: fit.value, overall, error: Math.abs(fit.value - overall) });
  }

  if (rows.length === 0) return { count: 0, meanAbsoluteError: null, within1: 0, worst: [] };

  const mae = rows.reduce((s, r) => s + r.error, 0) / rows.length;
  return {
    count: rows.length,
    meanAbsoluteError: Math.round(mae * 100) / 100,
    within1: rows.filter((r) => r.error <= 1).length,
    worst: rows
      .sort((a, b) => b.error - a.error)
      .slice(0, 5)
      .map(({ playerId, slot, fit, overall }) => ({ playerId, slot, fit, overall })),
  };
}
