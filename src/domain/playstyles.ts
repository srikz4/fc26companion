/**
 * PlayStyles, decoded from `players.trait1/trait2` and `icontrait1/icontrait2`.
 *
 * ## How this map was obtained
 *
 * The bit meanings ship with the game, not the save. They were derived the same
 * way the nameid table was (§2.5a): the imported player table carries a
 * `player_traits` list for 7,616 players, so for each bit we can ask which
 * PlayStyle every player with that bit set has in common, and vote.
 *
 * Two independent confirmations that the result is right:
 *
 *  1. `trait1` (the PlayStyle mask) and `icontrait1` (the PlayStyle+ mask) were
 *     derived separately and **agree on 28 of 29 shared bits**. They are different
 *     columns filled from different player populations; agreement is not luck.
 *  2. The resulting order matches EA's own PlayStyle categories exactly —
 *     bits 0-6 shooting, 7-13 passing, 14-19 defending, 20-29 physical/technical,
 *     and `trait2` bits 0-5 the six goalkeeper PlayStyles. A wrong map would not
 *     come out sorted by category.
 *
 * Per-bit agreement ran 74-99% for `trait1` (a player's listed PlayStyles are not
 * always exactly the set bits, which is what pulls it below 100%). `trait2` bits
 * 8 and above voted at 18-29% — noise, not PlayStyles — and are deliberately not
 * mapped. An unmapped bit renders as `bit N`, never as a guessed name.
 *
 * This is a derivation, so a PlayStyle is **provisional** in the sense of §2.3:
 * shown, but never allowed to drive a recommendation.
 */

/** trait1 bits 0-29: the outfield PlayStyles, in EA's category order. */
const TRAIT1_BITS = [
  'Finesse Shot',
  'Chip Shot',
  'Power Shot',
  'Dead Ball',
  'Precision Header',
  'Acrobatic',
  'Low Driven Shot',
  'Gamechanger',
  'Incisive Pass',
  'Pinged Pass',
  'Long Ball Pass',
  'Tiki Taka',
  'Whipped Pass',
  'Inventive',
  'Jockey',
  'Block',
  'Intercept',
  'Anticipate',
  'Slide Tackle',
  'Aerial Fortress',
  'Technical',
  'Rapid',
  'First Touch',
  'Trickster',
  'Press Proven',
  'Quick Step',
  'Relentless',
  'Long Throw',
  'Bruiser',
  'Enforcer',
] as const;

/** trait2 bits 0-5: the goalkeeper PlayStyles. Bits 6+ are not PlayStyles. */
const TRAIT2_BITS = [
  'Far Throw',
  'Footwork',
  'Cross Claimer',
  'Rush Out',
  'Far Reach',
  'Deflector',
] as const;

export type PlayStyleCategory = 'Shooting' | 'Passing' | 'Defending' | 'Physical' | 'Goalkeeping';

const CATEGORY_OF: Record<string, PlayStyleCategory> = {};
TRAIT1_BITS.forEach((name, bit) => {
  CATEGORY_OF[name] =
    bit <= 6 ? 'Shooting' : bit <= 13 ? 'Passing' : bit <= 19 ? 'Defending' : 'Physical';
});
TRAIT2_BITS.forEach((name) => {
  CATEGORY_OF[name] = 'Goalkeeping';
});

export interface PlayStyle {
  name: string;
  category: PlayStyleCategory | 'Unmapped';
  /** True when the game marks it PlayStyle+ (`icontrait1`/`icontrait2`). */
  plus: boolean;
}

function setBits(mask: unknown): number[] {
  if (typeof mask !== 'number' || mask === 0) return [];
  const bits: number[] = [];
  for (let i = 0; i < 32; i++) if (mask & (1 << i)) bits.push(i);
  return bits;
}

function nameFor(bank: 1 | 2, bit: number): string | null {
  const table = bank === 1 ? TRAIT1_BITS : TRAIT2_BITS;
  return table[bit] ?? null;
}

/**
 * Read a player's PlayStyles.
 *
 * A bit with no known meaning is reported as `bit N` in the `Unmapped` category
 * rather than dropped, so a title update that adds PlayStyles is visible instead
 * of silently swallowed.
 */
export function readPlayStyles(player: Record<string, unknown>): PlayStyle[] {
  const plusBits = new Set<string>();
  for (const bit of setBits(player['icontrait1'])) plusBits.add(`1:${bit}`);
  for (const bit of setBits(player['icontrait2'])) plusBits.add(`2:${bit}`);

  const styles: PlayStyle[] = [];
  const seen = new Set<string>();

  for (const [bank, field] of [
    [1, 'trait1'],
    [2, 'trait2'],
  ] as const) {
    for (const bit of setBits(player[field])) {
      const name = nameFor(bank, bit);
      // trait2 bits 6+ are not PlayStyles; skip rather than invent a label.
      if (name === null && bank === 2) continue;
      const label = name ?? `bit ${bit}`;
      if (seen.has(label)) continue;
      seen.add(label);
      styles.push({
        name: label,
        category: name === null ? 'Unmapped' : (CATEGORY_OF[name] ?? 'Unmapped'),
        plus: plusBits.has(`${bank}:${bit}`),
      });
    }
  }

  // A PlayStyle+ bit set without its base bit still counts.
  for (const [bank, field] of [
    [1, 'icontrait1'],
    [2, 'icontrait2'],
  ] as const) {
    for (const bit of setBits(player[field])) {
      const name = nameFor(bank, bit);
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      styles.push({ name, category: CATEGORY_OF[name] ?? 'Unmapped', plus: true });
    }
  }

  return styles.sort((a, b) => Number(b.plus) - Number(a.plus) || a.name.localeCompare(b.name));
}
