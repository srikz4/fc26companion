/**
 * The six attribute groups and their sub-attributes, plus positions and the
 * small enumerations the save stores as codes.
 *
 * Nothing here is computed — these are the game's own groupings, used so a card
 * reads the way the game reads.
 */
import type { Row } from '../parser/dbReader.ts';

export interface AttributeGroup {
  name: string;
  /** The headline value the game shows, when one exists as its own field. */
  members: readonly string[];
}

export const OUTFIELD_GROUPS: readonly AttributeGroup[] = [
  { name: 'Pace', members: ['acceleration', 'sprintspeed'] },
  {
    name: 'Shooting',
    members: ['positioning', 'finishing', 'shotpower', 'longshots', 'volleys', 'penalties'],
  },
  {
    name: 'Passing',
    members: ['vision', 'crossing', 'freekickaccuracy', 'shortpassing', 'longpassing', 'curve'],
  },
  {
    name: 'Dribbling',
    members: ['agility', 'balance', 'reactions', 'ballcontrol', 'dribbling', 'composure'],
  },
  {
    name: 'Defending',
    members: ['interceptions', 'headingaccuracy', 'defensiveawareness', 'standingtackle', 'slidingtackle'],
  },
  {
    name: 'Physical',
    members: ['jumping', 'stamina', 'strength', 'aggression'],
  },
] as const;

export const GK_GROUPS: readonly AttributeGroup[] = [
  { name: 'Diving', members: ['gkdiving'] },
  { name: 'Handling', members: ['gkhandling'] },
  { name: 'Kicking', members: ['gkkicking'] },
  { name: 'Reflexes', members: ['gkreflexes'] },
  { name: 'Speed', members: ['acceleration', 'sprintspeed'] },
  { name: 'Positioning', members: ['gkpositioning'] },
] as const;

/** Position codes as stored in `teamplayerlinks.position` / `preferredposition*`. */
export const POSITIONS: Record<number, string> = {
  0: 'GK',
  1: 'SW',
  2: 'RWB',
  3: 'RB',
  4: 'RCB',
  5: 'CB',
  6: 'LCB',
  7: 'LB',
  8: 'LWB',
  9: 'RDM',
  10: 'CDM',
  11: 'LDM',
  12: 'RM',
  13: 'RCM',
  14: 'CM',
  15: 'LCM',
  16: 'LM',
  17: 'RAM',
  18: 'CAM',
  19: 'LAM',
  20: 'RF',
  21: 'CF',
  22: 'LF',
  23: 'RW',
  24: 'RS',
  25: 'ST',
  26: 'LS',
  27: 'LW',
  28: 'SUB',
  29: 'RES',
};

export const positionName = (code: number | null): string =>
  code === null ? 'unknown' : (POSITIONS[code] ?? `#${code}`);

/**
 * The canonical short name for a position — the one the game itself prints.
 *
 * The raw codes distinguish left, centre and right versions of the same job
 * (RCB, CB, LCB all mean centre-back), which is useful on a team sheet and noise
 * in a filter. This collapses them to the names a person uses.
 */
const POSITION_SHORT: Record<number, string> = {
  0: 'GK',
  1: 'SW',
  2: 'RWB',
  3: 'RB',
  4: 'CB', 5: 'CB', 6: 'CB',
  7: 'LB',
  8: 'LWB',
  9: 'CDM', 10: 'CDM', 11: 'CDM',
  12: 'RM',
  13: 'CM', 14: 'CM', 15: 'CM',
  16: 'LM',
  17: 'CAM', 18: 'CAM', 19: 'CAM',
  20: 'RF',
  21: 'CF',
  22: 'LF',
  23: 'RW',
  24: 'ST', 25: 'ST', 26: 'ST',
  27: 'LW',
};

/** The game's own squad-screen order: keepers, back line left-to-right, then LW / RW / ST. */
export const POSITION_ORDER: readonly string[] = [
  'GK', 'SW', 'LWB', 'LB', 'CB', 'RB', 'RWB',
  'LM', 'CDM', 'CM', 'CAM', 'RM',
  'LW', 'LF', 'CF', 'RF', 'RW', 'ST',
];

export const positionShort = (code: number | null): string | null =>
  code === null ? null : (POSITION_SHORT[code] ?? null);

/** `teamplayerlinks.form`, 1 (worst) to 5 (best) as in the FC 25 watcher. */
export const FORM_LABELS: Record<number, string> = {
  1: 'Awful',
  2: 'Poor',
  3: 'Okay',
  4: 'Good',
  5: 'Excellent',
};

/** `players.emotion`. */
export const MORALE_LABELS: Record<number, string> = {
  0: 'Unhappy',
  1: 'Uneasy',
  2: 'Content',
  3: 'Happy',
  4: 'Very happy',
};

/** `career_playercontract.playerrole`, -1..5. */
export const SQUAD_ROLE_LABELS: Record<number, string> = {
  [-1]: 'None',
  0: 'Reserve',
  1: 'Crucial',
  2: 'Important',
  3: 'Rotation',
  4: 'Sporadic',
  5: 'Prospect',
};

/** Potential tags. Labels, not predictions (spec.md §5.3). */
export function potentialTag(potential: number | null): string | null {
  if (potential === null) return null;
  if (potential >= 91) return 'Special';
  if (potential >= 86) return 'Exciting';
  if (potential >= 80) return 'Great';
  return null;
}

/** EA stores dates as days since 1582-10-14. */
const EPOCH = Date.UTC(1582, 9, 14);

export function dateFromDays(days: number | null): string | null {
  if (days === null || !Number.isFinite(days) || days <= 0) return null;
  return new Date(EPOCH + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Age at the in-game date, not the wall clock (spec.md §3).
 * Returns null when either date is unavailable — never a plausible default.
 */
export function ageAt(birthDays: number | null, gameDate: number | null): number | null {
  const born = dateFromDays(birthDays);
  if (born === null || gameDate === null) return null;

  const now = String(gameDate);
  const [by, bm, bd] = born.split('-').map(Number) as [number, number, number];
  const ny = Number(now.slice(0, 4));
  const nm = Number(now.slice(4, 6));
  const nd = Number(now.slice(6, 8));

  let age = ny - by;
  if (nm < bm || (nm === bm && nd < bd)) age--;
  return age >= 0 && age < 60 ? age : null;
}

export const isGoalkeeper = (player: Row): boolean => player['preferredposition1'] === 0;

export const groupsFor = (player: Row): readonly AttributeGroup[] =>
  isGoalkeeper(player) ? GK_GROUPS : OUTFIELD_GROUPS;
