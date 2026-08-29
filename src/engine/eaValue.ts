/**
 * EA-style player valuation (spec.md §12): what the game itself would call a
 * fair price, as opposed to what this world's deals have paid (deals.ts).
 *
 * The game does not write player values to the save — verified, every table
 * swept — so the curves here were sampled from FIFACM's community FC 26 value
 * calculator (https://www.fifacm.com/calculator/value, 163 samples,
 * 2026-08-29) and refit as tables:
 *
 *   value = base[overall] × positionMod × ageMod(age, headroom) × potentialBoost(headroom)
 *
 * where ageMod interpolates between the no-headroom decline curve and the
 * much flatter high-ceiling curve, because a 31-year-old at his ceiling and a
 * 31-year-old with ten points left decay very differently in the data.
 *
 * Accuracy against held-out samples is mostly within ±5%, worst ±20% at the
 * extremes (very low-rated keepers, huge headrooms) — so the estimate ships
 * with a floor and ceiling band, is marked derived (~), and never drives a
 * rule. Calibrate against in-game screens whenever one disagrees.
 */

/** Sampled at ST, age 24, potential == overall. Index 0 is overall 48. */
const BASE_MIN_OVR = 48;
const BASE = [
  50_000, 50_000, 50_000, 70_000, 90_000, 110_000, 130_000, 150_000, 170_000, 190_000,
  240_000, 275_000, 300_000, 375_000, 475_000, 550_000, 675_000, 825_000, 1_000_000, 1_200_000,
  1_400_000, 1_600_000, 1_900_000, 2_200_000, 2_700_000, 3_600_000, 4_900_000, 6_500_000, 9_000_000, 12_500_000,
  16_500_000, 20_500_000, 24_500_000, 30_000_000, 35_500_000, 42_500_000, 49_500_000, 63_000_000, 79_500_000, 93_000_000,
  107_000_000, 120_500_000, 139_500_000, 153_500_000, 172_500_000, 194_500_000, 211_000_000, 233_000_000, 252_000_000, 287_500_000,
  307_000_000, 342_500_000,
]; // overall 48..99

/** Decline with age when potential == overall (sampled 80/80, age 16..40, ÷ value at 24). */
const AGE_MIN = 16;
const DECAY_ZERO = [
  0.8776, 0.8776, 0.9184, 0.9592, 0.9796, 1.0204, 1.0204, 1.0, 1.0, 0.9796,
  0.9592, 0.9388, 0.8776, 0.8571, 0.8367, 0.7347, 0.6939, 0.551, 0.4286, 0.3673,
  0.2857, 0.2857, 0.2857, 0.2857, 0.2857,
]; // age 16..40

/** Decline with age at ~15 points of headroom (sampled 70/85), interpolated per year. */
const DECAY_HIGH_SAMPLES: [number, number][] = [
  [16, 0.9568], [19, 0.9827], [22, 1.0086], [24, 1.0], [25, 0.9827],
  [28, 0.9568], [31, 0.8792], [34, 0.7241], [40, 0.55],
];

/** Value multiplier by headroom (potential − overall), sampled ovr 70 age 20, ÷ headroom-0 value. */
const POT_BOOST = [
  1.0, 1.111, 1.167, 1.222, 1.278, 1.333, 1.389, 1.778, 1.944, 1.944,
  1.944, 1.944, 2.167, 2.167, 2.167, 2.167, 2.333, 2.333, 2.333, 2.333,
  2.5, 2.778, 2.778, 2.778, 2.778, 2.778, 3.611,
]; // headroom 0..26

/** Position families, ÷ the attacking value (CAM/wide/ST sampled identical). */
const POS_MOD: Record<string, number> = {
  GK: 0.7347,
  CB: 0.8571,
  FB: 0.898, // RB, LB, RWB, LWB
  CDM: 0.8776,
  CM: 0.9796,
  ATT: 1.0, // CAM, RM/LM, wingers, forwards, ST
};

/**
 * The game's own position codes → valuation family.
 * 0 GK · 2/3/7/8 backs · 4/5/6 centre-backs · 9/10/11 holding · 13/14/15
 * central mids · everything wide or forward (12 RM, 16 LM, 17+ CAM/wing/ST)
 * priced as attackers, exactly as the samples show.
 */
export function valueFamily(positionCode: number | null): string {
  if (positionCode === null) return 'ATT';
  if (positionCode === 0) return 'GK';
  if (positionCode >= 4 && positionCode <= 6) return 'CB';
  if (positionCode >= 1 && positionCode <= 8) return 'FB';
  if (positionCode >= 9 && positionCode <= 11) return 'CDM';
  if (positionCode >= 13 && positionCode <= 15) return 'CM';
  return 'ATT';
}

const lerpAt = (samples: [number, number][], x: number): number => {
  if (x <= samples[0]![0]) return samples[0]![1];
  for (let i = 1; i < samples.length; i++) {
    const [x1, y1] = samples[i]!;
    const [x0, y0] = samples[i - 1]!;
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return samples[samples.length - 1]![1];
};

export interface EaValueBand {
  /** The EA-style fair value, in game money. Derived (~), never a rule input. */
  value: number;
  /** Do not accept below this in a negotiation. */
  floor: number;
  /** A ceiling a motivated buyer can be walked to. */
  ceiling: number;
}

/** Round the way the game presents money: to a tidy step for its size. */
const tidy = (v: number): number => {
  const step = v >= 50_000_000 ? 500_000 : v >= 5_000_000 ? 100_000 : v >= 1_000_000 ? 25_000 : 5_000;
  return Math.max(step, Math.round(v / step) * step);
};

export function eaValue(
  overall: number | null,
  age: number | null,
  potential: number | null,
  positionCode: number | null,
): EaValueBand | null {
  if (overall === null || age === null) return null;
  const ovr = Math.min(99, Math.max(BASE_MIN_OVR, Math.round(overall)));
  const base = BASE[ovr - BASE_MIN_OVR]!;

  const headroom = Math.max(0, Math.min(26, (potential ?? overall) - overall));
  const boost = POT_BOOST[headroom]!;

  const a = Math.min(AGE_MIN + DECAY_ZERO.length - 1, Math.max(AGE_MIN, Math.round(age)));
  const zero = DECAY_ZERO[a - AGE_MIN]!;
  const high = lerpAt(DECAY_HIGH_SAMPLES, a);
  const t = Math.min(1, headroom / 15);
  const ageMod = zero + (high - zero) * t;

  const pos = POS_MOD[valueFamily(positionCode)] ?? 1.0;

  const value = tidy(base * pos * ageMod * boost);
  // The in-game negotiation band around the value: walking away below ~90%,
  // and buyers can be pushed to roughly 130% before talks die. Approximate,
  // like the value itself.
  return { value, floor: tidy(value * 0.9), ceiling: tidy(value * 1.3) };
}
