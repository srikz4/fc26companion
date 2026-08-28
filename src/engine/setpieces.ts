/**
 * Set-piece takers and the armband — recommended from attributes, compared with
 * what the saved teamsheet actually has.
 *
 * Each role is a declared weighted formula over attributes the save carries.
 * Captaincy is the one role football does not store a number for; the model is
 * therefore stated in full and labelled as ours: composure and international
 * standing carry most of it, weighted toward players who are actually on the
 * pitch (minutes share) and in their leadership years.
 */
import type { Row } from '../parser/dbReader.ts';

const num = (row: Row, key: string): number | null =>
  typeof row[key] === 'number' ? (row[key] as number) : null;

export interface RoleCandidate {
  playerId: number;
  score: number;
}

export interface RoleRecommendation {
  role: string;
  icon: 'captain' | 'penalty' | 'freekick' | 'cross' | 'corner';
  /** Who the saved teamsheet has, when it records this role. */
  currentId: number | null;
  currentScore: number | null;
  /** Top three by the formula, best first. */
  recommended: RoleCandidate[];
  formula: string;
}

interface RoleSpec {
  role: string;
  icon: RoleRecommendation['icon'];
  attrs: Record<string, number>;
  formula: string;
}

const ROLES: readonly RoleSpec[] = [
  {
    role: 'Penalties',
    icon: 'penalty',
    attrs: { penalties: 0.7, composure: 0.3 },
    formula: 'penalties 70% · composure 30%',
  },
  {
    role: 'Direct free kicks',
    icon: 'freekick',
    attrs: { freekickaccuracy: 0.5, curve: 0.25, shotpower: 0.25 },
    formula: 'free kick accuracy 50% · curve 25% · shot power 25%',
  },
  {
    role: 'Crossed free kicks',
    icon: 'cross',
    attrs: { crossing: 0.45, curve: 0.35, freekickaccuracy: 0.2 },
    formula: 'crossing 45% · curve 35% · free kick accuracy 20%',
  },
  {
    role: 'Corners',
    icon: 'corner',
    attrs: { crossing: 0.5, curve: 0.5 },
    formula: 'crossing 50% · curve 50%',
  },
] as const;

const weighted = (player: Row, attrs: Record<string, number>): number | null => {
  let total = 0;
  let used = 0;
  for (const [attr, weight] of Object.entries(attrs)) {
    const value = num(player, attr);
    if (value === null || value <= 0) continue;
    total += value * weight;
    used += weight;
  }
  return used >= 0.6 ? Math.round(total / used) : null;
};

export interface SetPieceInput {
  /** Senior outfielders plus the keeper — anyone who could take one. */
  squad: Row[];
  /** Minutes played this season per player, for the captaincy model. */
  minutes: Map<number, number>;
  ageOf: (player: Row) => number | null;
  saved: {
    captainId: number | null;
    penaltyTakerId: number | null;
    freeKickTakerId: number | null;
    cornerTakerId: number | null;
  } | null;
}

export function recommendRoles(input: SetPieceInput): RoleRecommendation[] {
  const { squad, saved } = input;
  const out: RoleRecommendation[] = [];

  const top = (score: (p: Row) => number | null): RoleCandidate[] =>
    squad
      .map((p) => ({ playerId: num(p, 'playerid')!, score: score(p) }))
      .filter((c): c is RoleCandidate => c.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

  const savedIdFor: Record<string, number | null> = {
    Penalties: saved?.penaltyTakerId ?? null,
    'Direct free kicks': saved?.freeKickTakerId ?? null,
    'Crossed free kicks': null, // the teamsheet stores one FK taker, not two kinds
    Corners: saved?.cornerTakerId ?? null,
  };

  for (const spec of ROLES) {
    const recommended = top((p) => weighted(p, spec.attrs));
    if (!recommended.length) continue;
    const currentId = savedIdFor[spec.role] ?? null;
    const current = currentId !== null ? squad.find((p) => num(p, 'playerid') === currentId) : undefined;
    out.push({
      role: spec.role,
      icon: spec.icon,
      currentId,
      currentScore: current ? weighted(current, spec.attrs) : null,
      recommended,
      formula: spec.formula,
    });
  }

  // Captaincy. No leadership attribute exists in the save, so the model is ours
  // and says so: composure 40%, international reputation 20%, minutes share 25%,
  // leadership years 15% (peaking at 29, fading either side).
  const maxMinutes = Math.max(1, ...input.minutes.values());
  const captainScore = (p: Row): number | null => {
    const composure = num(p, 'composure');
    if (composure === null) return null;
    const rep = (num(p, 'internationalrep') ?? 1) * 20;
    const share = ((input.minutes.get(num(p, 'playerid')!) ?? 0) / maxMinutes) * 100;
    const age = input.ageOf(p);
    const years = age === null ? 50 : Math.max(0, 100 - Math.abs(age - 29) * 8);
    return Math.round(composure * 0.4 + rep * 0.2 + share * 0.25 + years * 0.15);
  };
  const captains = top(captainScore);
  if (captains.length) {
    const current = saved?.captainId !== null && saved?.captainId !== undefined
      ? squad.find((p) => num(p, 'playerid') === saved.captainId)
      : undefined;
    out.push({
      role: 'Captain',
      icon: 'captain',
      currentId: saved?.captainId ?? null,
      currentScore: current ? captainScore(current) : null,
      recommended: captains,
      formula: 'composure 40% · international reputation 20% · minutes share 25% · leadership years 15% — our model; the save stores no leadership figure',
    });
  }

  return out;
}
