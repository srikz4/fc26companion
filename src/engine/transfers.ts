/**
 * Transfer targets, from the save's own world (spec.md §3.8).
 *
 * Every player in the file is a real player in your career, so candidates are
 * found rather than imagined. What this does **not** do is predict whether a bid
 * would be accepted, price a fee, or rate a club's willingness to sell — none of
 * that is in the save, and the FC 26 companion's bid-acceptance percentages were
 * fiction.
 *
 * A candidate is ranked on things that are facts:
 *
 *   - it fills a **depth gap** we actually have;
 *   - his **fit** for that slot beats what we have;
 *   - his **contract** is short, so he is gettable (a free agent in 6 months is a
 *     different proposition from one on a five-year deal);
 *   - he **synergises** with players already here, by the declared rules;
 *   - `player_grudgelove` records **affinity toward our club**.
 */
import type { Row } from '../parser/dbReader.ts';
import { fitFor, slotOf, type Slot } from './fit.ts';
import { positionShort } from '../domain/attributes.ts';
import { targetSynergy, type ChannelLink, type SynergyReport } from './synergy.ts';
import { contractMonths } from './wages.ts';
import type { DealsModel, FeeEstimate } from './deals.ts';

const num = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;

export interface DepthGap {
  slot: Slot;
  /** How many squad players cover it at a usable level. */
  cover: number;
  /** Best fit we currently have. */
  bestFit: number | null;
  severity: 'none' | 'thin' | 'gap';
  note: string;
}

/**
 * Minimum bodies a slot wants before it stops being thin.
 *
 * WB is absent on purpose. The game almost never lists RWB/LWB as a player's
 * primary position — wing-back is a role a full-back plays — so requiring natural
 * cover there reports a hole in every squad in the game. WB stays a fit slot for
 * the tactics view; it is not a depth requirement.
 */
const WANTED_COVER: Record<Exclude<Slot, 'WB'>, number> = {
  GK: 2,
  CB: 4,
  FB: 3,
  CDM: 2,
  CM: 3,
  CAM: 2,
  W: 4,
  ST: 3,
};

export function depthGaps(squad: Row[]): DepthGap[] {
  const gaps: DepthGap[] = [];

  for (const slot of Object.keys(WANTED_COVER) as Exclude<Slot, 'WB'>[]) {
    const fits = squad
      .map((p) => fitFor(p, slot))
      .filter((f): f is NonNullable<typeof f> => f !== null && f.familiar)
      .map((f) => f.value)
      .sort((a, b) => b - a);

    const cover = fits.length;
    const wanted = WANTED_COVER[slot];
    const severity = cover === 0 ? 'gap' : cover < wanted ? 'thin' : 'none';

    gaps.push({
      slot,
      cover,
      bestFit: fits[0] ?? null,
      severity,
      note:
        severity === 'gap'
          ? `Nobody in the squad plays ${slot} naturally.`
          : severity === 'thin'
            ? `${cover} natural ${slot}${cover === 1 ? '' : 's'}, ${wanted} wanted.`
            : `${cover} covered.`,
    });
  }

  return gaps.sort((a, b) => {
    const rank = { gap: 0, thin: 1, none: 2 } as const;
    return rank[a.severity] - rank[b.severity] || a.cover - b.cover;
  });
}

export type Archetype = 'superstar' | 'rising' | 'wonderkid' | 'underdog';

export interface TransferTarget {
  playerId: number;
  name: string;
  /** Which shopping list he belongs on. A player can be more than one. */
  archetypes: Archetype[];
  /** The game's own short position (RW, LB…), not our internal slot. */
  posShort: string | null;
  /** Fitted fair-fee band from this world's observed deals, when a model exists. */
  feeGuide: FeeEstimate | null;
  /** What this world pays a player of that profile, per week. */
  wageGuide: FeeEstimate | null;
  teamId: number | null;
  teamName: string | null;
  slot: Slot;
  fit: number;
  overall: number;
  potential: number | null;
  headroom: number;
  age: number | null;
  /** How much better his fit is than our best in that slot. */
  upgrade: number;
  contractMonths: number | null;
  /** Out of contract within a year. */
  gettable: boolean;
  wantsUs: boolean;
  /** His strongest channels with the current squad, from the synergy model. */
  synergy: ChannelLink[];
  /** Best channel vs the strongest existing channel of the same pattern. */
  synergyGain: number | null;
  reasons: string[];
  /**
   * The same reasoning, structured so the client can badge it instead of
   * printing a semicolon-jammed sentence. `kind` drives the colour, `text` is
   * the short form, `detail` the full sentence for the tooltip.
   */
  reasonTags: { kind: 'gap' | 'upgrade' | 'contract' | 'synergy' | 'affinity' | 'growth'; text: string; detail: string }[];
}

export interface TransferSearch {
  gaps: DepthGap[];
  targets: TransferTarget[];
  scanned: number;
}

export interface TransferOptions {
  /** Only consider players at or above this overall. */
  minOverall?: number;
  maxAge?: number;
  /** Cap the returned list. */
  limit?: number;
  /**
   * The career's own gender (players.gender: 0 men, 1 women). Both rosters
   * share the players table, so the target pool must match the squad — a
   * men's career never shops the women's pool and vice versa.
   */
  gender?: number;
}

/**
 * Scan the world for players who would improve a slot we are short in.
 *
 * The scan is bounded by the gaps we actually have — searching all 21,634 players
 * against all nine slots would return a shopping list, not advice.
 */
export function findTargets(
  world: Row[],
  squad: Row[],
  ourClubId: number | null,
  gameDate: number | null,
  squadSynergy: SynergyReport,
  affinity: Map<number, Set<number>>,
  nameOf: (id: number) => string,
  clubOf: Map<number, number>,
  teamNames: Map<number, string>,
  /** Clubs a player can actually be signed from (see `eligibleClubs`). */
  eligible: Set<number>,
  teamOverall: Map<number, number>,
  dealsModel: DealsModel,
  options: TransferOptions = {},
): TransferSearch {
  const { minOverall = 62, maxAge = 32, limit = 70, gender = 0 } = options;
  const gaps = depthGaps(squad);
  // Short slots first, but a clear upgrade anywhere is worth surfacing — "find
  // better talent" is a different question from "fill a hole".
  const wanted = gaps;

  const squadIds = new Set(squad.map((p) => num(p, 'playerid')));
  const targets: TransferTarget[] = [];
  let scanned = 0;

  for (const player of world) {
    const playerId = num(player, 'playerid');
    const overall = num(player, 'overallrating');
    if (playerId === null || overall === null) continue;
    if (squadIds.has(playerId)) continue;
    if (overall < minOverall) continue;
    // Both rosters share the players table and the free-agent league carries
    // no gender flag — match on the player's own field against the career's.
    if ((num(player, 'gender') ?? 0) !== gender) continue;

    // Only players at a real club in a real domestic league. Without this the
    // list fills with national squads, women's teams and the Classic XI, none of
    // which you can sign from.
    const club = clubOf.get(playerId);
    if (club === undefined || !eligible.has(club)) continue;

    scanned++;

    const birth = num(player, 'birthdate');
    const age = birth !== null && gameDate !== null ? ageFrom(birth, gameDate) : null;
    // No readable age means no advice: this is how the Classic XI and other icon
    // squads drop out, since they carry no usable birth date. Better to say
    // nothing about a player than to rank him on a blank.
    if (age === null) continue;
    if (age > maxAge) continue;

    const primary = slotOf(num(player, 'preferredposition1'));
    const months = contractMonths(num(player, 'contractvaliduntil'), gameDate);

    for (const gap of wanted) {
      // Only consider players who play the slot naturally: signing a converted
      // full-back to fix a centre-back gap is a different decision.
      if (primary !== gap.slot) continue;

      const fit = fitFor(player, gap.slot);
      if (!fit) continue;

      const upgrade = gap.bestFit === null ? fit.value : fit.value - gap.bestFit;
      const potential = num(player, 'potential');

      // Archetypes are shopping lists, not quality gates: a wonderkid or a
      // hidden gem earns his place by what he could become, not by upgrading
      // the first XI today.
      const clubLevel = club !== undefined ? (teamOverall.get(club) ?? null) : null;
      const archetypes: Archetype[] = [];
      if (overall >= 85) archetypes.push('superstar');
      if (overall >= 77 && overall < 85 && (potential ?? 0) >= 84) archetypes.push('rising');
      if (age <= 21 && (potential ?? 0) >= 86) archetypes.push('wonderkid');
      if (
        (potential ?? 0) >= 80 &&
        overall < 80 &&
        clubLevel !== null &&
        clubLevel <= 72
      ) {
        archetypes.push('underdog');
      }

      // A hole takes anyone credible; a covered slot needs a real improvement —
      // unless he is on a shopping list, which is its own reason to appear.
      const bar = gap.severity === 'gap' ? -99 : gap.severity === 'thin' ? 0 : 3;
      if (upgrade < bar && archetypes.length === 0) continue;
      const syn = targetSynergy(player, squad, squadSynergy);
      const wantsUs = ourClubId !== null && (affinity.get(playerId)?.has(ourClubId) ?? false);

      const reasons: string[] = [];
      const reasonTags: TransferTarget['reasonTags'] = [];
      const tag = (kind: TransferTarget['reasonTags'][number]['kind'], text: string, detail: string): void => {
        reasonTags.push({ kind, text, detail });
        reasons.push(detail);
      };

      if (gap.severity === 'gap') tag('gap', `Fills ${gap.slot}`, `fills a hole at ${gap.slot}`);
      else if (gap.severity === 'thin') tag('gap', `Depth ${gap.slot}`, `adds depth at ${gap.slot}`);
      if (upgrade > 0) tag('upgrade', `+${upgrade} fit`, `${upgrade} better fit than our best ${gap.slot}`);
      if (months !== null && months <= 12) {
        tag('contract', months <= 6 ? 'Deal expiring' : `${months}m left`, `${months} months left on their contract`);
      }
      if (syn.best[0]) {
        const partner = nameOf(syn.best[0].supplier === playerId ? syn.best[0].receiver : syn.best[0].supplier);
        tag(
          'synergy',
          `${syn.best[0].channel} ${syn.best[0].strength}`,
          `${syn.best[0].channel} ${syn.best[0].strength} with ${partner}`,
        );
      }
      if (wantsUs) tag('affinity', 'Wants us', 'the save records affinity toward this club');
      if (potential !== null && potential - overall >= 8) {
        tag('growth', `+${potential - overall} to grow`, `${potential - overall} of headroom left`);
      }

      targets.push({
        playerId,
        name: nameOf(playerId),
        archetypes,
        posShort: positionShort(num(player, 'preferredposition1')),
        feeGuide:
          dealsModel.estimate && potential !== null
            ? dealsModel.estimate(overall, age, potential)
            : null,
        wageGuide:
          dealsModel.wageEstimate && potential !== null
            ? dealsModel.wageEstimate(overall, age, potential)
            : null,
        teamId: clubOf.get(playerId) ?? null,
        teamName: teamNames.get(clubOf.get(playerId) ?? -1) ?? null,
        slot: gap.slot,
        fit: fit.value,
        overall,
        potential,
        headroom: potential === null ? 0 : potential - overall,
        age,
        upgrade,
        contractMonths: months,
        gettable: months !== null && months <= 12,
        wantsUs,
        synergy: syn.best,
        synergyGain: syn.gainOverIncumbent,
        reasons,
        reasonTags,
      });
    }
  }

  // Rank on how much better, then how gettable, then how well he would fit in.
  targets.sort(
    (a, b) =>
      b.upgrade - a.upgrade ||
      Number(b.gettable) - Number(a.gettable) ||
      (b.synergy[0]?.strength ?? 0) - (a.synergy[0]?.strength ?? 0) ||
      b.potential! - a.potential!,
  );

  return { gaps, targets: targets.slice(0, limit), scanned };
}

const EPOCH = Date.UTC(1582, 9, 14);

function ageFrom(birthDays: number, gameDate: number): number | null {
  const born = new Date(EPOCH + birthDays * 86_400_000);
  const year = Math.floor(gameDate / 10000);
  const month = Math.floor((gameDate % 10000) / 100);
  const day = gameDate % 100;

  let age = year - born.getUTCFullYear();
  const bm = born.getUTCMonth() + 1;
  const bd = born.getUTCDate();
  if (month < bm || (month === bm && day < bd)) age--;
  return age >= 0 && age < 60 ? age : null;
}

/**
 * Clubs you could sign a player from: teams in a domestic league on the
 * career's own side of the game — men's leagues for a men's career, women's
 * leagues (`iswomencompetition`) for a women's career — never international.
 *
 * These are fields in the save, so this is a filter on facts rather than a
 * list of names to skip.
 */
export function eligibleClubs(leagueTeamLinks: Row[], leagues: Row[], women = false): Set<number> {
  const ok = new Set<number>();
  const goodLeagues = new Set<number>();

  for (const league of leagues) {
    const id = num(league, 'leagueid');
    if (id === null) continue;
    if (((num(league, 'iswomencompetition') ?? 0) !== 0) !== women) continue;
    if ((num(league, 'isinternationalleague') ?? 0) !== 0) continue;
    goodLeagues.add(id);
  }

  for (const link of leagueTeamLinks) {
    const teamId = num(link, 'teamid');
    const leagueId = num(link, 'leagueid');
    if (teamId !== null && leagueId !== null && goodLeagues.has(leagueId)) ok.add(teamId);
  }

  return ok;
}

/** `player_grudgelove` at level 6+ reads as affinity toward that club. */
export function affinityIndex(rows: Row[], minLevel = 6): Map<number, Set<number>> {
  const index = new Map<number, Set<number>>();
  for (const row of rows) {
    const level = num(row, 'level_of_emotion');
    const playerId = num(row, 'playerid');
    const teamId = num(row, 'emotional_teamid');
    if (level === null || playerId === null || teamId === null || level < minLevel) continue;
    const set = index.get(playerId) ?? new Set<number>();
    set.add(teamId);
    index.set(playerId, set);
  }
  return index;
}
