/**
 * Synergy — which players make each other better, measured.
 *
 * This replaces an earlier version built on shared nationality and shared former
 * clubs. Those are trivia. What a manager means by synergy is footballing:
 * a crosser needs a header, a through-ball needs a runner, a ball-playing keeper
 * needs a pivot who wants it. That is a relationship between *attributes*, and
 * attributes are numbers, so it can be computed instead of asserted.
 *
 * ## The model, declared in full
 *
 * A **channel** is a named way two players combine, with a supplier side and a
 * receiver side, each a weighted set of attributes (weights sum to 1):
 *
 *     supplier score = Σ w·attr        (0-99, same scale as the attributes)
 *     receiver score = Σ w·attr
 *     strength       = √(supplier × receiver)
 *
 * The geometric mean is the honesty in the formula: a 95 crosser aimed at a 50
 * header scores 69, not 72.5 — a channel is only as strong as its weak end, and
 * the square root punishes imbalance exactly as much as it should.
 *
 * PlayStyles amplify: a channel whose supplier or receiver carries a directly
 * relevant PlayStyle gains +3 per side (+5 for the PlayStyle+ version). The bump
 * is small because the attributes already carry most of the signal — the
 * PlayStyle says the game *executes* the action better, so it earns a nudge,
 * not a multiplier.
 *
 * Channels are gated by slot, both ends, because a Whipped Pass centre-back
 * aimed at a Precision Header goalkeeper is not a partnership.
 *
 * A **duty pair** is the other kind of synergy: two players sharing a unit
 * (centre-backs, a double pivot) where what matters is *coverage* — between
 * them, is every duty of the unit handled? Duty score per player is a weighted
 * attribute mean; the pair takes the max per duty; coverage is the mean of the
 * maxes; and the interesting number is the **gain**: coverage minus the better
 * player's solo coverage. A high gain means they complete each other. A gain
 * near zero with high profile similarity means you bought the same player twice
 * — which is what the redundancy check reports, using cosine similarity of
 * z-scored profiles against the world population for that position.
 *
 * ## What this is not
 *
 * None of these numbers predicts an outcome. "Cross → header 87" ranks the
 * pairing against alternatives in the same squad on the same declared formula;
 * it does not claim goals. Every number decomposes to the attributes and
 * weights that produced it, shown on demand.
 */
import type { Row } from '../parser/dbReader.ts';
import { readPlayStyles } from '../domain/playstyles.ts';
import { slotOf, type Slot } from './fit.ts';
import {
  profileSimilarity,
  zProfile,
  type WorldStats,
} from './percentiles.ts';
import type { FormationShape } from './formations.ts';

const num = (row: Row, key: string): number | null =>
  typeof row[key] === 'number' ? (row[key] as number) : null;

/* ------------------------------------------------------------------ channels */

interface ChannelEnd {
  slots: readonly Slot[];
  /** attribute -> weight; weights sum to 1. */
  attrs: Record<string, number>;
  /** PlayStyles that amplify this end. */
  styles?: readonly string[];
}

export interface Channel {
  id: string;
  name: string;
  from: ChannelEnd;
  to: ChannelEnd;
  why: string;
}

/**
 * The channel catalogue. Each is a real pattern of play; the slot gates say
 * where it happens on a pitch, the attribute weights say what it is made of.
 */
export const CHANNELS: readonly Channel[] = [
  {
    id: 'CH-CROSS',
    name: 'Cross → header',
    from: { slots: ['W', 'FB', 'WB'], attrs: { crossing: 0.6, curve: 0.4 }, styles: ['Whipped Pass'] },
    to: {
      slots: ['ST'],
      attrs: { headingaccuracy: 0.5, jumping: 0.3, positioning: 0.2 },
      styles: ['Precision Header', 'Aerial Fortress'],
    },
    why: 'wide delivery onto an aerial threat',
  },
  {
    id: 'CH-THROUGH',
    name: 'Through ball → runner',
    from: {
      slots: ['CM', 'CAM', 'CDM'],
      attrs: { vision: 0.5, shortpassing: 0.3, longpassing: 0.2 },
      styles: ['Incisive Pass', 'Pinged Pass'],
    },
    to: {
      slots: ['ST', 'W'],
      attrs: { acceleration: 0.35, sprintspeed: 0.35, positioning: 0.3 },
      styles: ['Rapid', 'Quick Step'],
    },
    why: 'a passer who sees it early, a runner who beats the line',
  },
  {
    id: 'CH-SWITCH',
    name: 'Switch of play',
    from: {
      slots: ['CDM', 'CM', 'CB'],
      attrs: { longpassing: 0.6, vision: 0.4 },
      styles: ['Long Ball Pass'],
    },
    to: {
      slots: ['W', 'WB', 'FB'],
      attrs: { ballcontrol: 0.5, agility: 0.3, acceleration: 0.2 },
      styles: ['First Touch'],
    },
    why: 'the long diagonal to the far flank, killed instantly',
  },
  {
    id: 'CH-CUTBACK',
    name: 'Carry → cutback finish',
    from: {
      slots: ['W', 'CAM'],
      attrs: { dribbling: 0.4, agility: 0.3, ballcontrol: 0.3 },
      styles: ['Trickster', 'Technical', 'Rapid'],
    },
    to: {
      slots: ['ST', 'CAM', 'CM'],
      attrs: { finishing: 0.5, positioning: 0.35, composure: 0.15 },
      styles: ['Finesse Shot', 'Low Driven Shot'],
    },
    why: 'a carrier who reaches the byline, a finisher arriving late',
  },
  {
    id: 'CH-LINK',
    name: 'Link-up in the pocket',
    from: {
      slots: ['ST', 'CAM'],
      attrs: { shortpassing: 0.4, vision: 0.3, ballcontrol: 0.3 },
      styles: ['Tiki Taka', 'Inventive'],
    },
    to: {
      slots: ['ST', 'CAM', 'W', 'CM'],
      attrs: { positioning: 0.4, composure: 0.3, ballcontrol: 0.3 },
      styles: ['First Touch'],
    },
    why: 'one drops in to feet, the other spins beyond',
  },
  {
    id: 'CH-BUILDOUT',
    name: 'Keeper build-out',
    from: { slots: ['GK'], attrs: { gkkicking: 0.7, composure: 0.3 }, styles: ['Footwork'] },
    to: {
      slots: ['CB', 'CDM', 'FB'],
      attrs: { ballcontrol: 0.4, composure: 0.4, shortpassing: 0.2 },
      styles: ['Tiki Taka'],
    },
    why: 'a keeper who can find the pivot under a press',
  },
  {
    id: 'CH-PROGRESS',
    name: 'Progression into midfield',
    from: {
      slots: ['CB', 'CDM'],
      attrs: { shortpassing: 0.4, longpassing: 0.3, vision: 0.3 },
      styles: ['Incisive Pass', 'Long Ball Pass'],
    },
    to: {
      slots: ['CM', 'CAM'],
      attrs: { ballcontrol: 0.4, composure: 0.3, agility: 0.3 },
      styles: ['First Touch', 'Technical'],
    },
    why: 'defence to midfield without a punt',
  },
  {
    id: 'CH-OVERLAP',
    name: 'Overlap',
    from: {
      slots: ['FB', 'WB'],
      attrs: { stamina: 0.35, sprintspeed: 0.35, crossing: 0.3 },
      styles: ['Relentless', 'Quick Step'],
    },
    to: {
      slots: ['W'],
      attrs: { dribbling: 0.5, ballcontrol: 0.3, vision: 0.2 },
      styles: ['Trickster', 'Inventive'],
    },
    why: 'a full-back who runs all day outside a winger who holds it',
  },
  {
    id: 'CH-PRESS',
    name: 'Press and cover',
    from: {
      slots: ['ST', 'W', 'CAM'],
      attrs: { aggression: 0.35, stamina: 0.35, acceleration: 0.3 },
      styles: ['Press Proven', 'Relentless'],
    },
    to: {
      slots: ['CM', 'CDM'],
      attrs: { interceptions: 0.4, defensiveawareness: 0.35, stamina: 0.25 },
      styles: ['Intercept', 'Anticipate'],
    },
    why: 'the first press forces it, the second man reads it',
  },
] as const;

/* -------------------------------------------------------------- duty pairs */

interface Duty {
  name: string;
  attrs: Record<string, number>;
}

interface DutyUnit {
  id: string;
  name: string;
  slot: Slot;
  duties: readonly Duty[];
}

/** Units where two players share one job and must cover it between them. */
export const DUTY_UNITS: readonly DutyUnit[] = [
  {
    id: 'DU-CB',
    name: 'Centre-back pairing',
    slot: 'CB',
    duties: [
      { name: 'Aerial', attrs: { headingaccuracy: 0.4, jumping: 0.3, strength: 0.3 } },
      { name: 'Recovery pace', attrs: { sprintspeed: 0.6, acceleration: 0.4 } },
      { name: 'Reading the game', attrs: { interceptions: 0.5, defensiveawareness: 0.5 } },
      { name: 'On the ball', attrs: { shortpassing: 0.4, ballcontrol: 0.3, composure: 0.3 } },
    ],
  },
  {
    id: 'DU-PIVOT',
    name: 'Double pivot',
    slot: 'CDM',
    duties: [
      { name: 'Screening', attrs: { interceptions: 0.4, defensiveawareness: 0.35, standingtackle: 0.25 } },
      { name: 'Legs', attrs: { stamina: 0.6, sprintspeed: 0.4 } },
      { name: 'Progression', attrs: { shortpassing: 0.4, longpassing: 0.3, vision: 0.3 } },
    ],
  },
] as const;

/* ------------------------------------------------------------------ scoring */

const end = (player: Row, side: ChannelEnd): number => {
  let total = 0;
  let used = 0;
  for (const [attr, weight] of Object.entries(side.attrs)) {
    const value = num(player, attr);
    if (value === null || value <= 0) continue;
    total += value * weight;
    used += weight;
  }
  return used >= 0.6 ? total / used : 0;
};

const styleBonus = (styles: Set<string>, plus: Set<string>, wanted?: readonly string[]): number => {
  if (!wanted) return 0;
  for (const name of wanted) {
    if (plus.has(name)) return 5;
    if (styles.has(name)) return 3;
  }
  return 0;
};

export interface PlayerProfile {
  id: number;
  slot: Slot | null;
  row: Row;
  styles: Set<string>;
  plusStyles: Set<string>;
}

export function profileOf(player: Row): PlayerProfile {
  const styles = readPlayStyles(player as Record<string, unknown>);
  return {
    id: num(player, 'playerid')!,
    slot: slotOf(num(player, 'preferredposition1')),
    row: player,
    styles: new Set(styles.map((s) => s.name)),
    plusStyles: new Set(styles.filter((s) => s.plus).map((s) => s.name)),
  };
}

export interface ChannelLink {
  channelId: string;
  channel: string;
  why: string;
  supplier: number;
  receiver: number;
  supplierScore: number;
  receiverScore: number;
  /** √(supplier × receiver) plus PlayStyle bonuses, rounded. 0-99-ish scale. */
  strength: number;
  /** Names of PlayStyles that earned a bonus, so the bump is visible. */
  amplifiedBy: string[];
}

/** All channels that connect a pair, strongest first. Direction is per channel. */
export function channelsBetween(a: PlayerProfile, b: PlayerProfile): ChannelLink[] {
  const links: ChannelLink[] = [];

  for (const channel of CHANNELS) {
    for (const [sup, rec] of [
      [a, b],
      [b, a],
    ] as [PlayerProfile, PlayerProfile][]) {
      if (sup.slot === null || rec.slot === null) continue;
      if (!channel.from.slots.includes(sup.slot) || !channel.to.slots.includes(rec.slot)) continue;
      if (sup.id === rec.id) continue;

      const supplierScore = end(sup.row, channel.from);
      const receiverScore = end(rec.row, channel.to);
      if (supplierScore === 0 || receiverScore === 0) continue;

      const amplifiedBy: string[] = [];
      let bonus = 0;
      const supBonus = styleBonus(sup.styles, sup.plusStyles, channel.from.styles);
      if (supBonus) {
        bonus += supBonus;
        amplifiedBy.push(...(channel.from.styles ?? []).filter((s) => sup.styles.has(s)).slice(0, 1));
      }
      const recBonus = styleBonus(rec.styles, rec.plusStyles, channel.to.styles);
      if (recBonus) {
        bonus += recBonus;
        amplifiedBy.push(...(channel.to.styles ?? []).filter((s) => rec.styles.has(s)).slice(0, 1));
      }

      links.push({
        channelId: channel.id,
        channel: channel.name,
        why: channel.why,
        supplier: sup.id,
        receiver: rec.id,
        supplierScore: Math.round(supplierScore),
        receiverScore: Math.round(receiverScore),
        strength: Math.round(Math.sqrt(supplierScore * receiverScore) + bonus),
        amplifiedBy,
      });
    }
  }

  return links.sort((x, y) => y.strength - x.strength);
}

/* ------------------------------------------------------------- duty scoring */

export interface DutyCoverage {
  unitId: string;
  unit: string;
  a: number;
  b: number;
  /** Mean over duties of the pair's best score per duty. */
  coverage: number;
  /** Coverage minus the stronger player's solo coverage: what the pair adds. */
  gain: number;
  perDuty: { duty: string; a: number; b: number; covered: number; carrier: number }[];
}

export function dutyCoverage(unit: DutyUnit, a: PlayerProfile, b: PlayerProfile): DutyCoverage | null {
  if (a.slot !== unit.slot || b.slot !== unit.slot) return null;

  const perDuty = unit.duties.map((duty) => {
    const scoreA = end(a.row, { slots: [unit.slot], attrs: duty.attrs });
    const scoreB = end(b.row, { slots: [unit.slot], attrs: duty.attrs });
    return {
      duty: duty.name,
      a: Math.round(scoreA),
      b: Math.round(scoreB),
      covered: Math.round(Math.max(scoreA, scoreB)),
      carrier: scoreA >= scoreB ? a.id : b.id,
    };
  });

  const coverage = perDuty.reduce((s, d) => s + d.covered, 0) / perDuty.length;
  const soloA = perDuty.reduce((s, d) => s + d.a, 0) / perDuty.length;
  const soloB = perDuty.reduce((s, d) => s + d.b, 0) / perDuty.length;

  return {
    unitId: unit.id,
    unit: unit.name,
    a: a.id,
    b: b.id,
    coverage: Math.round(coverage * 10) / 10,
    gain: Math.round((coverage - Math.max(soloA, soloB)) * 10) / 10,
    perDuty,
  };
}

/* ------------------------------------------------------------- XI synergy */

export interface XILink extends ChannelLink {
  distance: number;
}

export interface XISynergy {
  /** Mean of the best channel per interacting pair. Our declared model. */
  teamScore: number | null;
  links: XILink[];
  /** Adjacent pairs with no channel above the floor — where the XI does not connect. */
  coldPairs: { a: number; b: number; distance: number }[];
}

/** Two players interact when the formation stands them near each other. */
const ADJACENT = 0.42;
const CHANNEL_FLOOR = 55;

export function xiSynergy(
  shape: FormationShape,
  placed: { index: number; playerId: number | null }[],
  profiles: Map<number, PlayerProfile>,
): XISynergy {
  const links: XILink[] = [];
  const coldPairs: XISynergy['coldPairs'] = [];

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const pa = placed[i]!;
      const pb = placed[j]!;
      if (pa.playerId === null || pb.playerId === null) continue;

      const sa = shape.spots[pa.index];
      const sb = shape.spots[pb.index];
      if (!sa || !sb) continue;
      const distance = Math.hypot(sa.x - sb.x, sa.y - sb.y);
      if (distance > ADJACENT) continue;

      const a = profiles.get(pa.playerId);
      const b = profiles.get(pb.playerId);
      if (!a || !b) continue;

      const best = channelsBetween(a, b)[0];
      if (best && best.strength >= CHANNEL_FLOOR) {
        links.push({ ...best, distance: Math.round(distance * 100) / 100 });
      } else {
        coldPairs.push({ a: pa.playerId, b: pb.playerId, distance: Math.round(distance * 100) / 100 });
      }
    }
  }

  links.sort((x, y) => y.strength - x.strength);
  return {
    teamScore: links.length
      ? Math.round((links.reduce((s, l) => s + l.strength, 0) / links.length) * 10) / 10
      : null,
    links,
    coldPairs,
  };
}

/* --------------------------------------------------------------- squad view */

export interface RedundancyNote {
  a: number;
  b: number;
  slot: Slot;
  similarity: number;
}

export interface SynergyReport {
  /** Best partnerships across the whole squad, strongest first. */
  partnerships: ChannelLink[];
  /** Duty coverage for the units that exist in this squad. */
  units: DutyCoverage[];
  /** Same-slot pairs whose profiles are near-identical shapes. */
  redundancies: RedundancyNote[];
  /** Per player: his best links, for the card. */
  byPlayer: Map<number, ChannelLink[]>;
}

export function buildSynergy(squad: Row[], stats: WorldStats | null): SynergyReport {
  const profiles = squad.map(profileOf);

  const partnerships: ChannelLink[] = [];
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const best = channelsBetween(profiles[i]!, profiles[j]!)[0];
      if (best && best.strength >= CHANNEL_FLOOR) partnerships.push(best);
    }
  }
  partnerships.sort((a, b) => b.strength - a.strength);

  const units: DutyCoverage[] = [];
  for (const unit of DUTY_UNITS) {
    const eligible = profiles.filter((p) => p.slot === unit.slot);
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const cover = dutyCoverage(unit, eligible[i]!, eligible[j]!);
        if (cover) units.push(cover);
      }
    }
  }
  units.sort((a, b) => b.coverage - a.coverage);

  const redundancies: RedundancyNote[] = [];
  if (stats) {
    const zCache = new Map<number, Map<string, number> | null>();
    const zOf = (p: PlayerProfile): Map<string, number> | null => {
      if (!zCache.has(p.id)) zCache.set(p.id, zProfile(stats, p.slot, p.row));
      return zCache.get(p.id) ?? null;
    };
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const a = profiles[i]!;
        const b = profiles[j]!;
        if (a.slot === null || a.slot !== b.slot || a.slot === 'GK') continue;
        const za = zOf(a);
        const zb = zOf(b);
        if (!za || !zb) continue;
        const similarity = profileSimilarity(za, zb);
        if (similarity !== null && similarity >= 0.9) {
          redundancies.push({ a: a.id, b: b.id, slot: a.slot, similarity: Math.round(similarity * 100) / 100 });
        }
      }
    }
    redundancies.sort((a, b) => b.similarity - a.similarity);
  }

  const byPlayer = new Map<number, ChannelLink[]>();
  for (const link of partnerships) {
    for (const id of [link.supplier, link.receiver]) {
      const list = byPlayer.get(id) ?? [];
      if (list.length < 3) list.push(link);
      byPlayer.set(id, list);
    }
  }

  return { partnerships, units, redundancies, byPlayer };
}

/* ----------------------------------------------------------- transfer angle */

export interface TargetSynergy {
  /** His strongest channels with current squad members. */
  best: ChannelLink[];
  /** How he compares to the current best channel involving his slot. */
  gainOverIncumbent: number | null;
}

/**
 * What a signing would add: run the same channels between the candidate and the
 * squad, then compare his best against the strongest existing channel that his
 * slot participates in. A positive gain means the pattern gets stronger the day
 * he arrives — which is the question "who do I bring in?" actually asks.
 */
export function targetSynergy(
  candidate: Row,
  squad: Row[],
  existing: SynergyReport,
): TargetSynergy {
  const profile = profileOf(candidate);
  const links: ChannelLink[] = [];
  for (const mate of squad) {
    if (num(mate, 'playerid') === profile.id) continue;
    const best = channelsBetween(profile, profileOf(mate))[0];
    if (best && best.strength >= CHANNEL_FLOOR) links.push(best);
  }
  links.sort((a, b) => b.strength - a.strength);
  const best = links.slice(0, 3);

  let gainOverIncumbent: number | null = null;
  if (best[0] && profile.slot !== null) {
    const incumbent = existing.partnerships.find(
      (l) => l.channelId === best[0]!.channelId,
    );
    gainOverIncumbent = incumbent ? best[0].strength - incumbent.strength : null;
  }

  return { best, gainOverIncumbent };
}
