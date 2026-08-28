/**
 * The View document: everything the client renders, computed from one parsed save
 * plus whatever history the store holds.
 *
 * Two independent sources of change over time, and they are kept apart:
 *
 *  - **Season growth** comes from `career_playergrowthuserseason`, which is the
 *    squad's per-attribute state at the start of the season. It is present in a
 *    single save, so growth is visible from the very first snapshot.
 *  - **Snapshot history** comes from the store: one point per save ingested. It
 *    is sparse at first and fills in as you play. Gaps stay gaps (spec.md §3).
 *
 * Nothing here invents a value. A field the save does not carry is `null`, and
 * the client renders it as unknown.
 */
import type { Row, Tables } from '../parser/dbReader.ts';
import type { HistoryStore } from '../store/store.ts';
import type { NameResolver, NameOrigin } from '../names/nameTable.ts';
import { readPlayStyles, type PlayStyle } from '../domain/playstyles.ts';
import {
  ageAt,
  dateFromDays,
  FORM_LABELS,
  groupsFor,
  isGoalkeeper,
  MORALE_LABELS,
  positionName,
  positionShort,
  potentialTag,
  SQUAD_ROLE_LABELS,
} from '../domain/attributes.ts';
import { YOUTH_TEAM_ID } from '../core/saveLocation.ts';
import { allFits, bestFit, calibrationReport, fitFor, slotOf, type Slot } from './fit.ts';
import {
  buildSynergy,
  profileOf as synergyProfile,
  xiSynergy,
  CHANNELS,
  type ChannelLink,
  type SynergyReport,
  type XISynergy,
} from './synergy.ts';
import {
  agePercentile,
  buildWorldStats,
  standoutAttributes,
  type WorldStats,
} from './percentiles.ts';
import { alertRail, availabilityAlerts, evaluate, type AlertLine, type Advice, type RuleInput } from './rules.ts';
import { buildWageReport, contractMonths, type WageReport } from './wages.ts';
import {
  candidateFrom,
  compareShapes,
  diffSelection,
  pickXI,
  readFormations,
  readSavedXI,
  readTeamSheets,
  type SavedXI,
  type SelectionDiff,
  type ShapeComparison,
  type XI,
} from './formations.ts';
import { affinityIndex, eligibleClubs, findTargets, type TransferSearch } from './transfers.ts';
import { buildRegenReport, type RegenReport } from './regens.ts';
import { recommendRoles, type RoleRecommendation } from './setpieces.ts';
import { buildLoans, type LoansView } from './loans.ts';
import { buildDealsModel, type DealsModel } from './deals.ts';

const num = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;
const rowsOf = (t: Tables, name: string): Row[] => t[name] ?? [];

export interface AttributeValue {
  name: string;
  value: number | null;
  /** Change since the start of the season, from the growth baseline. */
  seasonDelta: number | null;
}

export interface AttributeGroupView {
  name: string;
  attributes: AttributeValue[];
  /** Mean of the group's members, one decimal. Our figure, not the game's. */
  mean: number | null;
  seasonDelta: number | null;
}

export interface SeriesPoint {
  gameDate: number | null;
  observedAt: string;
  value: number | null;
}

export interface MatchRating {
  date: number;
  rating: number;
  minutes: number;
  position: string;
}

export interface PlayerView {
  playerId: number;
  name: string;
  nameOrigin: NameOrigin;
  nameProvisional: boolean;
  squad: 'senior' | 'academy';

  jersey: number | null;
  position: string;
  /** Canonical short name — GK, RB, CB, CDM, RW and so on. */
  positionShort: string | null;
  /** The game's own position code, which is already in football order. */
  positionCode: number | null;
  preferredPositions: string[];
  age: number | null;
  birthDate: string | null;

  overall: number | null;
  potential: number | null;
  headroom: number | null;
  potentialTag: string | null;

  overallSeasonDelta: number | null;
  /** Ceiling change since July 1, from this career's own snapshots. */
  potentialSeasonDelta: number | null;
  overallSeries: SeriesPoint[];
  potentialSeries: SeriesPoint[];

  groups: AttributeGroupView[];
  playStyles: PlayStyle[];
  roles: number[];

  height: number | null;
  weight: number | null;
  foot: 'Left' | 'Right' | null;
  skillMoves: number | null;
  weakFoot: number | null;

  form: string | null;
  morale: string | null;
  injured: boolean;
  retiring: boolean;
  transferBlocked: boolean;
  onLoan: boolean;
  /** Team id of a national-team call-up, when the save records one. */
  nationalTeam: number | null;

  wage: number | null;
  contractUntil: number | null;
  squadRole: string | null;

  minutesThisSeason: number | null;
  appearances: number | null;
  goals: number | null;
  averageRating: number | null;
  recentRatings: MatchRating[];

  advice: Advice;
  otherAdvice: Advice[];
  fits: { slot: string; value: number; familiar: boolean }[];
  bestSlot: string | null;
  synergy: ChannelLink[];
  /** Attributes in the top of the position's world population. */
  standout: { attr: string; value: number; percentile: number }[];
  /** Where he stands against everyone his age in this world. */
  generation: { overall: number; potential: number | null; peers: number } | null;
  /** Spread of his match ratings — low means he shows up every week. */
  ratingSpread: number | null;
  isNewgen: boolean;
  contractMonths: number | null;
  wageVerdict: string | null;
  wageNote: string | null;

  /** Academy only. */
  youth: {
    monthsInSquad: number | null;
    tier: number | null;
    potentialLow: number | null;
    potentialVariance: number | null;
  } | null;
}

export interface ViewDocument {
  generatedAt: string;
  club: { id: number | null; name: string | null; overall: number | null };
  manager: string | null;
  season: number | null;
  gameDate: number | null;
  gameDateBasis: string | null;
  gameDateIsEstimate: true;
  snapshots: number;
  names: { squad: [number, number]; academy: [number, number]; tableSize: number };
  senior: PlayerView[];
  academy: PlayerView[];
  alerts: AlertLine[];
  matchday: MatchdayView;
  synergy: SynergyView;
  transfers: TransferSearch;
  loans: LoansView;
  scouts: ScoutView[];
  board: {
    reputation: number | null;
    totalEarnings: number | null;
    wage: number | null;
    /**
     * The seasonobjective enum slots. In the dev career they are all zero while
     * the game's board screen shows three objectives — the visible objectives
     * live in career_competitionprogress, not here (O-1, narrowed 2026-08-28).
     */
    objectivesSet: number;
    competitions: {
      name: string;
      season: number;
      won: boolean;
      result: number | null;
      /** stageid -1: the competition has not started yet this season. */
      notStarted: boolean;
    }[];
    /** career_managerinfo's own record books. */
    bigWin: { userScore: number; oppScore: number; opponent: string; date: number } | null;
    bigLoss: { userScore: number; oppScore: number; opponent: string; date: number } | null;
  };
  deals: { observed: DealsModel['deals']; sample: number; modelled: boolean };
  seasons: SeasonRecord[];
  regens: RegenReport;
  wages: WageReport & { assessmentList: { playerId: number; verdict: string; note: string; wage: number | null; peerMedian: number | null }[] };
  stats: StatsView;
  warnings: string[];
}

export interface MatchdayView {
  saved: SavedXI | null;
  recommended: XI | null;
  diff: SelectionDiff[];
  shapes: ShapeComparison[];
  /** Every saved team sheet, scored: mean anchored fit of its XI in its own positions. */
  sheets: { name: string; shapeName: string | null; players: number; today: number | null }[];
  unavailable: { playerId: number; name: string; reason: string }[];
  /** Calibration of our fit numbers against the game's ratings. */
  calibration: ReturnType<typeof calibrationReport>;
  /** Set-piece takers and the armband: saved vs our formula's pick. */
  roles: RoleRecommendation[];
  /** The shape to play now, and the shape that grows the squad, when they differ. */
  shapeAdvice: {
    now: { name: string; today: number | null; growth: number | null } | null;
    development: { name: string; today: number | null; growth: number | null; todayCost: number } | null;
  };
  fixtureKnown: false;
  note: string;
}

export interface SynergyView {
  /** The saved/recommended XI's interacting pairs, scored by the channel model. */
  xi: XISynergy | null;
  partnerships: ChannelLink[];
  units: SynergyReport['units'];
  redundancies: SynergyReport['redundancies'];
  catalogue: { id: string; name: string; why: string }[];
  worldPlayers: number;
}

export interface ScoutView {
  scoutId: number;
  name: string;
  nationality: string | null;
  knowledge: number | null;
  experience: number | null;
  mission: {
    positions: string[];
    nation: string | null;
    returns: string | null;
    cost: number | null;
  } | null;
  /** Where to send this scout next, from the squad's thin slots and the world's talent pools. */
  nextJob: string | null;
}

export interface SeasonRecord {
  season: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number | null;
  position: number | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
  leagueTrophies: number;
  cupTrophies: number;
  bigBuy: { name: string; amount: number } | null;
  bigSell: { name: string; amount: number } | null;
}

export interface StatsView {
  squadSize: number;
  academySize: number;
  meanOverall: number | null;
  meanAge: number | null;
  meanPotential: number | null;
  totalMinutes: number;
  wageBill: number;
  byPosition: { slot: string; count: number; meanOverall: number | null; meanAge: number | null }[];
  topScorers: { playerId: number; name: string; goals: number }[];
  bestRated: { playerId: number; name: string; rating: number; apps: number }[];
  mostMinutes: { playerId: number; name: string; minutes: number }[];
  biggestRisers: { playerId: number; name: string; delta: number }[];
  /** Every observed ceiling move this season, falls first — they need a decision. */
  ceilingWatch: {
    playerId: number;
    name: string;
    delta: number;
    minutes: number | null;
    age: number | null;
    squad: string;
  }[];
  ageProfile: { band: string; count: number }[];
}

interface BuildInput {
  tables: Tables;
  resolver: NameResolver;
  store?: HistoryStore | undefined;
  careerId?: number | undefined;
  nameTableSize?: number;
  /** nation id -> name, from data/nations_fc26.csv. Empty map shows ids. */
  nations?: Map<number, string>;
  /** competition code -> name, from data/competitions.csv. */
  competitions?: Map<string, string>;
}

export function buildViewDocument(input: BuildInput): ViewDocument {
  const { tables, resolver } = input;
  const warnings: string[] = [];

  const user = rowsOf(tables, 'career_users')[0];
  const info = rowsOf(tables, 'career_managerinfo')[0];
  const clubId = num(info, 'clubteamid') ?? num(user, 'clubteamid');
  const club = rowsOf(tables, 'teams').find((t) => num(t, 'teamid') === clubId);

  const gameDate = estimateDate(tables);

  // Seasons run July to June; this stamp bounds the ceiling-drift window so
  // the delta always means "since this season began".
  const seasonStartYmd = (() => {
    if (gameDate.date === null) return 0; // no date estimate: use every snapshot
    const y = Math.floor(gameDate.date / 10000);
    const m = Math.floor((gameDate.date % 10000) / 100);
    return (m >= 7 ? y : y - 1) * 10000 + 701;
  })();

  const players = new Map<number, Row>();
  for (const p of rowsOf(tables, 'players')) {
    const id = num(p, 'playerid');
    if (id !== null) players.set(id, p);
  }

  // A player has one link row per squad he belongs to — club *and* national team.
  // Keying naively on playerid keeps whichever came last, which silently dropped
  // nine Man Utd internationals from the squad. Prefer our club, then the academy.
  const links = new Map<number, Row>();
  const nationalTeam = new Map<number, number>();
  for (const l of rowsOf(tables, 'teamplayerlinks')) {
    const id = num(l, 'playerid');
    const teamId = num(l, 'teamid');
    if (id === null) continue;

    const ours = teamId === clubId || teamId === YOUTH_TEAM_ID;
    if (ours || !links.has(id)) {
      const existing = links.get(id);
      const existingIsOurs =
        existing !== undefined &&
        (num(existing, 'teamid') === clubId || num(existing, 'teamid') === YOUTH_TEAM_ID);
      if (ours || !existingIsOurs) links.set(id, l);
    }
    if (!ours && teamId !== null) nationalTeam.set(id, teamId);
  }

  const contracts = new Map<number, Row>();
  for (const c of rowsOf(tables, 'career_playercontract')) {
    const id = num(c, 'playerid');
    if (id !== null) contracts.set(id, c);
  }

  const baseline = new Map<number, Row>();
  for (const g of rowsOf(tables, 'career_playergrowthuserseason')) {
    const id = num(g, 'playerid');
    if (id !== null) baseline.set(id, g);
  }
  if (baseline.size === 0) {
    warnings.push('No season growth baseline in this save — per-attribute season change is unknown.');
  }

  const youthRows = new Map<number, Row>();
  for (const y of rowsOf(tables, 'career_youthplayers')) {
    const id = num(y, 'playerid');
    if (id !== null) youthRows.set(id, y);
  }

  const blocked = new Set(
    rowsOf(tables, 'career_transferblock')
      .map((r) => num(r, 'playerid'))
      .filter((v): v is number => v !== null),
  );
  const loaned = new Set(
    rowsOf(tables, 'playerloans')
      .map((r) => num(r, 'playerid'))
      .filter((v): v is number => v !== null),
  );

  const ratings = new Map<number, MatchRating[]>();
  for (const r of rowsOf(tables, 'career_playermatchratinghistory')) {
    const id = num(r, 'playerid');
    const date = num(r, 'date');
    const rating = num(r, 'rating');
    if (id === null || date === null || rating === null) continue;
    const list = ratings.get(id) ?? [];
    list.push({
      date,
      rating,
      minutes: num(r, 'minsplayed') ?? 0,
      position: positionName(num(r, 'position')),
    });
    ratings.set(id, list);
  }
  for (const list of ratings.values()) list.sort((a, b) => a.date - b.date);

  const squadOf = (teamId: number | null): number[] =>
    teamId === null
      ? []
      : [
          ...new Set(
            rowsOf(tables, 'teamplayerlinks')
              .filter((l) => num(l, 'teamid') === teamId)
              .map((l) => num(l, 'playerid'))
              .filter((v): v is number => v !== null),
          ),
        ];

  const seniorIds = squadOf(clubId);
  // Academy is the academy squad, nothing else. A youth-table row for someone who
  // has moved to another club is not our prospect, and a row with no `players`
  // record is not a player at all (spec.md §2.5a).
  const academyIds = squadOf(YOUTH_TEAM_ID);


  const nameOf = (id: number): string => resolver.resolve(id).display;

  const seniorRows = seniorIds.map((id) => players.get(id)).filter((p): p is Row => p !== undefined);
  const academyRows = academyIds.map((id) => players.get(id)).filter((p): p is Row => p !== undefined);

  // Minutes are shared out against the club's busiest player, which is the only
  // denominator the save supports — there is no fixture count to divide by.
  const maxMinutes = Math.max(
    1,
    ...seniorIds.map((id) => (ratings.get(id) ?? []).reduce((s2, m) => s2 + m.minutes, 0)),
  );

  // Depth by slot, for the loan and blocked-pathway rules.
  const depthBySlot = new Map<Slot, { playerId: number; potential: number; overall: number; age: number | null }[]>();
  for (const row of seniorRows) {
    const slot = slotOf(num(row, 'preferredposition1'));
    if (!slot) continue;
    const id = num(row, 'playerid')!;
    const list = depthBySlot.get(slot) ?? [];
    list.push({
      playerId: id,
      potential: num(row, 'potential') ?? 0,
      overall: num(row, 'overallrating') ?? 0,
      age: ageAt(num(row, 'birthdate'), gameDate.date),
    });
    depthBySlot.set(slot, list);
  }
  for (const list of depthBySlot.values()) list.sort((a, b) => b.overall - a.overall);

  // World statistics: every percentile and z-score in the document comes from
  // the 21,634 players actually in this career's world.
  // The career's own side of the game, read from the squad itself (both
  // rosters share the players table; a squad is never mixed). 0 men, 1 women.
  const careerGender =
    seniorRows.map((r) => num(r, 'gender')).find((g) => g !== null) ?? 0;
  // Percentiles compare against the pool the squad is drawn from — the same
  // gender's world, whichever that is.
  const worldRows = rowsOf(tables, 'players').filter(
    (p) => (num(p, 'gender') ?? 0) === careerGender,
  );
  const worldStats: WorldStats = buildWorldStats(worldRows, (p) =>
    ageAt(num(p, 'birthdate'), gameDate.date),
  );
  const synergyReport = buildSynergy([...seniorRows, ...academyRows], worldStats);

  // Selection: the XI you saved versus the one the fit table would pick.
  const shapes = readFormations(rowsOf(tables, 'formations'));
  const availability = new Map<number, string>();
  for (const id of seniorIds) {
    const link = links.get(id);
    if ((num(link, 'injury') ?? 0) !== 0) availability.set(id, 'injured');
    else if ((num(link, 'reds') ?? 0) > 0) availability.set(id, 'suspended');
  }
  const candidates = seniorRows
    .map((row) => candidateFrom(row, !availability.has(num(row, 'playerid')!)))
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const savedXI = readSavedXI(rowsOf(tables, 'cm_mentalities'), rowsOf(tables, 'cm_teamsheets'));
  const allSheets = readTeamSheets(rowsOf(tables, 'cm_mentalities'), rowsOf(tables, 'cm_teamsheets'));
  const savedShape =
    shapes.find((sh) => sh.formationId === savedXI?.formationId) ??
    shapes.find((sh) => sh.name === '4-2-3-1') ??
    shapes[0];
  const recommendedXI = savedShape ? pickXI(savedShape, candidates) : null;
  const selectionDiff =
    savedXI && recommendedXI ? diffSelection(savedXI, recommendedXI, candidates) : [];

  const selectionCostFor = new Map<number, { slot: string; instead: string; fitCost: number }>();
  for (const d of selectionDiff) {
    if (d.savedPlayerId === null || d.recommendedPlayerId === null) continue;
    if (d.savedPlayerId === d.recommendedPlayerId || d.fitCost === null || d.fitCost <= 0) continue;
    selectionCostFor.set(d.savedPlayerId, {
      slot: d.slot ?? positionName(d.positionCode),
      instead: nameOf(d.recommendedPlayerId),
      fitCost: d.fitCost,
    });
  }

  // Wages.
  const wageInputs = [...seniorIds, ...academyIds].map((id) => {
    const player = players.get(id);
    const overall = num(player, 'overallrating');
    const potential = num(player, 'potential');
    return {
      playerId: id,
      wage: num(contracts.get(id), 'wage'),
      roleCode: num(contracts.get(id), 'playerrole'),
      age: ageAt(num(player, 'birthdate'), gameDate.date),
      headroom: overall !== null && potential !== null ? potential - overall : null,
      contractMonths: contractMonths(num(player, 'contractvaliduntil'), gameDate.date),
    };
  });
  const wages = buildWageReport(wageInputs);

  const ruleInputs = new Map<number, RuleInput>();

  const build = (id: number, squad: 'senior' | 'academy'): PlayerView | null => {
    const player = players.get(id);
    if (!player) return null;

    const link = links.get(id);
    const contract = contracts.get(id);
    const base = baseline.get(id);
    const youth = youthRows.get(id);
    const name = resolver.resolve(id);

    const overall = num(player, 'overallrating');
    const potential = num(player, 'potential');
    const baseOverall = num(base, 'overall');

    // Ceiling drift, observed inside this career (A-3, verified 2026-08-28:
    // potential moved 84 -> 85 across snapshots). The save keeps no
    // season-start potential, so the base is our earliest snapshot since
    // July 1 — which also means a drift of null reads "no snapshots yet",
    // never "no change".
    const potentialPoints =
      input.store && input.careerId !== undefined
        ? input.store
            .series(input.careerId, id, 'potential')
            .filter((p2) => p2.gameDate !== null && p2.gameDate >= seasonStartYmd && p2.value !== null)
        : [];
    const ceilingDrift =
      potential !== null && potentialPoints.length > 0 ? potential - potentialPoints[0]!.value! : null;

    const groups = groupsFor(player).map((group) => {
      const attributes: AttributeValue[] = group.members.map((key) => {
        const value = num(player, key);
        const was = num(base, key);
        return {
          name: key,
          value,
          seasonDelta: value !== null && was !== null ? value - was : null,
        };
      });
      const present = attributes.filter((a) => a.value !== null);
      const deltas = attributes.filter((a) => a.seasonDelta !== null);
      return {
        name: group.name,
        attributes,
        mean: present.length
          ? Math.round((present.reduce((s, a) => s + a.value!, 0) / present.length) * 10) / 10
          : null,
        seasonDelta: deltas.length
          ? Math.round((deltas.reduce((s, a) => s + a.seasonDelta!, 0) / deltas.length) * 10) / 10
          : null,
      };
    });

    const history = ratings.get(id) ?? [];
    const minutes = history.reduce((s, m) => s + m.minutes, 0);

    const age = ageAt(num(player, 'birthdate'), gameDate.date);
    const headroom = overall !== null && potential !== null ? potential - overall : null;
    const months = contractMonths(num(player, 'contractvaliduntil'), gameDate.date);
    const wageAssessment = wages.assessments.get(id);

    const fits = allFits(player);
    const best = bestFit(player);
    const primarySlot = slotOf(num(player, 'preferredposition1'));

    // Reposition only counts when the better slot is one he already plays.
    const reposition =
      best && primarySlot && best.slot !== primarySlot && best.familiar
        ? {
            from: primarySlot,
            to: best.slot,
            gain: best.value - (fits.find((f) => f.slot === primarySlot)?.value ?? best.value),
          }
        : null;

    const depth = primarySlot ? (depthBySlot.get(primarySlot) ?? []) : [];
    const depthRank = depth.findIndex((d) => d.playerId === id);

    // Blocked: someone ahead of him is at his ceiling and not going anywhere.
    let blockedBy: RuleInput['blockedBy'] = null;
    if (depthRank > 0 && potential !== null) {
      const ahead = depth[0]!;
      const aheadPlayer = players.get(ahead.playerId);
      const aheadHeadroom = (num(aheadPlayer, 'potential') ?? 0) - ahead.overall;
      if (aheadHeadroom <= 1 && potential > ahead.overall && (ahead.age ?? 99) < 32) {
        blockedBy = { name: nameOf(ahead.playerId), seasons: Math.max(1, 32 - (ahead.age ?? 30)) };
      }
    }

    const ruleInput: RuleInput = {
      playerId: id,
      name: name.display,
      age,
      overall,
      potential,
      headroom,
      minutesPct: squad === 'senior' && history.length ? (minutes / maxMinutes) * 100 : squad === 'senior' ? 0 : null,
      overallSeasonDelta: overall !== null && baseOverall !== null ? overall - baseOverall : null,
      ceilingDriftSeason: ceilingDrift,
      contractMonths: months,
      squad,
      reposition,
      blocking: null,
      blockedBy,
      depthRank: depthRank >= 0 ? depthRank + 1 : null,
      depthRankTwoPotential: depth[1]?.potential ?? null,
      injured: (num(link, 'injury') ?? 0) !== 0,
      retiring: (num(player, 'isretiring') ?? 0) !== 0,
      selectionCost: selectionCostFor.get(id) ?? null,
    };
    ruleInputs.set(id, ruleInput);
    const advice = evaluate(ruleInput);
    const avg = history.length
      ? Math.round((history.reduce((s, m) => s + m.rating, 0) / history.length) * 10) / 10
      : null;

    const series = (field: string): SeriesPoint[] =>
      input.store && input.careerId !== undefined
        ? input.store.series(input.careerId, id, field).map((p) => ({
            gameDate: p.gameDate,
            observedAt: '',
            value: p.value,
          }))
        : [];

    const preferred = [1, 2, 3, 4]
      .map((n) => num(player, `preferredposition${n}`))
      .filter((v): v is number => v !== null && v >= 0)
      .map((c) => positionShort(c) ?? positionName(c));

    return {
      playerId: id,
      name: name.display,
      nameOrigin: name.origin,
      nameProvisional: name.provisional,
      squad,

      jersey: num(link, 'jerseynumber'),
      position: positionName(num(player, 'preferredposition1') ?? num(link, 'position')),
      positionShort: positionShort(num(player, 'preferredposition1') ?? num(link, 'position')),
      positionCode: num(player, 'preferredposition1') ?? num(link, 'position'),
      preferredPositions: [...new Set(preferred)],
      age: ageAt(num(player, 'birthdate'), gameDate.date),
      birthDate: dateFromDays(num(player, 'birthdate')),

      overall,
      potential,
      headroom: overall !== null && potential !== null ? potential - overall : null,
      potentialTag: potentialTag(potential),

      overallSeasonDelta: overall !== null && baseOverall !== null ? overall - baseOverall : null,
      potentialSeasonDelta: ceilingDrift,
      overallSeries: series('overallrating'),
      potentialSeries: series('potential'),

      groups,
      playStyles: readPlayStyles(player as Record<string, unknown>),
      roles: [1, 2, 3]
        .map((n) => num(player, `role${n}`))
        .filter((v): v is number => v !== null && v > 0),

      height: num(player, 'height'),
      weight: num(player, 'weight'),
      foot: num(player, 'preferredfoot') === 2 ? 'Left' : num(player, 'preferredfoot') === 1 ? 'Right' : null,
      skillMoves: num(player, 'skillmoves'),
      weakFoot: num(player, 'weakfootabilitytypecode'),

      form: FORM_LABELS[num(link, 'form') ?? -1] ?? null,
      morale: MORALE_LABELS[num(player, 'emotion') ?? -1] ?? null,
      injured: (num(link, 'injury') ?? 0) !== 0,
      retiring: (num(player, 'isretiring') ?? 0) !== 0,
      transferBlocked: blocked.has(id),
      onLoan: loaned.has(id),
      nationalTeam: nationalTeam.get(id) ?? null,

      wage: num(contract, 'wage'),
      contractUntil: num(player, 'contractvaliduntil'),
      squadRole: SQUAD_ROLE_LABELS[num(contract, 'playerrole') ?? -99] ?? null,

      minutesThisSeason: history.length ? minutes : null,
      appearances: history.length || null,
      goals: num(link, 'leaguegoals'),
      averageRating: avg,
      recentRatings: history.slice(-8),

      advice: advice.primary,
      otherAdvice: advice.others,
      fits: fits.map((f) => ({ slot: f.slot, value: f.value, familiar: f.familiar })),
      bestSlot: best?.slot ?? null,
      synergy: synergyReport.byPlayer.get(id) ?? [],
      standout: standoutAttributes(worldStats, slotOf(num(player, 'preferredposition1')), player),
      generation: agePercentile(worldStats, age, overall, potential),
      ratingSpread:
        history.length >= 5
          ? Math.round(
              Math.sqrt(
                history.reduce((s2, m) => s2 + (m.rating - (avg ?? 0)) ** 2, 0) / history.length,
              ) * 10,
            ) / 10
          : null,
      isNewgen: id >= 400_000,
      contractMonths: months,
      wageVerdict: wageAssessment?.verdict ?? null,
      wageNote: wageAssessment?.note ?? null,

      youth: youth
        ? {
            monthsInSquad: num(youth, 'monthsinsquad'),
            tier: num(youth, 'playertier'),
            potentialLow: num(youth, 'swinglowpotential'),
            potentialVariance: num(youth, 'potentialvariance'),
          }
        : null,
    };
  };

  const senior = seniorIds
    .map((id) => build(id, 'senior'))
    .filter((p): p is PlayerView => p !== null)
    .sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));

  const academy = academyIds
    .map((id) => build(id, 'academy'))
    .filter((p): p is PlayerView => p !== null)
    .sort((a, b) => (b.potential ?? 0) - (a.potential ?? 0));

  const covered = (list: PlayerView[]): [number, number] => [
    list.filter((p) => p.nameOrigin !== 'unresolved').length,
    list.length,
  ];

  // --- everything that needs the finished player lists ---

  const everyone = [...senior, ...academy];
  const results = everyone
    .map((p) => ({ input: ruleInputs.get(p.playerId), result: { primary: p.advice, others: p.otherAdvice } }))
    .filter((r): r is { input: RuleInput; result: { primary: Advice; others: Advice[] } } => r.input !== undefined);

  const alerts = [
    ...availabilityAlerts(
      everyone.map((p) => ({ playerId: p.playerId, name: p.name, injured: p.injured, squad: p.squad })),
    ),
    ...alertRail(results),
  ];

  const teamNames = new Map<number, string>();
  for (const t of rowsOf(tables, 'teams')) {
    const id = num(t, 'teamid');
    const teamName = t['teamname'];
    if (id !== null && typeof teamName === 'string') teamNames.set(id, teamName);
  }

  const shapeTable = compareShapes(shapes, candidates).slice(0, 12);
  const bestNow = shapeTable[0] ?? null;
  const bestGrowth = shapeTable
    .filter((s2) => (s2.todayCost ?? 99) <= 1.5 && s2.xi.shape.name !== bestNow?.xi.shape.name)
    .sort((a, b) => (b.xi.growth ?? 0) - (a.xi.growth ?? 0))[0];

  const minutesById = new Map<number, number>();
  for (const [id, list] of ratings) {
    minutesById.set(id, list.reduce((s2, m) => s2 + m.minutes, 0));
  }

  const matchday: MatchdayView = {
    saved: savedXI,
    recommended: recommendedXI,
    diff: selectionDiff,
    shapes: shapeTable,
    sheets: allSheets.map((sheet) => {
      const fits = sheet.players
        .map((pl) => {
          const row = players.get(pl.playerId);
          const slot = slotOf(pl.positionCode);
          if (!row || !slot) return null;
          return fitFor(row, slot)?.value ?? null;
        })
        .filter((v): v is number => v !== null);
      return {
        name: sheet.tacticName ?? 'Unnamed sheet',
        shapeName: shapes.find((sh) => sh.formationId === sheet.formationId)?.name ?? null,
        players: sheet.players.length,
        today: fits.length ? Math.round((fits.reduce((a, b) => a + b, 0) / fits.length) * 10) / 10 : null,
      };
    }),
    roles: recommendRoles({
      squad: seniorRows,
      minutes: minutesById,
      ageOf: (p) => ageAt(num(p, 'birthdate'), gameDate.date),
      saved: savedXI
        ? {
            captainId: savedXI.captainId,
            penaltyTakerId: savedXI.penaltyTakerId,
            freeKickTakerId: savedXI.freeKickTakerId,
            cornerTakerId: savedXI.cornerTakerId,
          }
        : null,
    }),
    shapeAdvice: {
      now: bestNow
        ? { name: bestNow.xi.shape.name, today: bestNow.xi.today, growth: bestNow.xi.growth }
        : null,
      development:
        bestGrowth && (bestGrowth.xi.growth ?? 0) > (bestNow?.xi.growth ?? 0) + 1
          ? {
              name: bestGrowth.xi.shape.name,
              today: bestGrowth.xi.today,
              growth: bestGrowth.xi.growth,
              todayCost: bestGrowth.todayCost ?? 0,
            }
          : null,
    },
    unavailable: [...availability.entries()].map(([playerId, reason]) => ({
      playerId,
      name: nameOf(playerId),
      reason,
    })),
    calibration: calibrationReport(seniorRows),
    fixtureKnown: false,
    note:
      'The career save carries no fixture list, so there is no opponent to prepare against. ' +
      'What is here is your own side: the XI you saved, the XI the fit table would pick, and the cost of the difference.',
  };

  const synergy: SynergyView = {
    xi:
      recommendedXI && savedShape
        ? xiSynergy(
            savedShape,
            recommendedXI.assignments.map((a) => ({ index: a.index, playerId: a.playerId })),
            new Map(
              [...seniorRows, ...academyRows].map((r) => {
                const prof = synergyProfile(r);
                return [prof.id, prof];
              }),
            ),
          )
        : null,
    partnerships: synergyReport.partnerships.slice(0, 20),
    units: synergyReport.units,
    redundancies: synergyReport.redundancies,
    catalogue: CHANNELS.map((c) => ({ id: c.id, name: c.name, why: c.why })),
    worldPlayers: worldStats.players,
  };

  // Where every player in the world currently plays, so a target is not just an
  // id floating free of a club.
  const clubOf = new Map<number, number>();
  for (const l of rowsOf(tables, 'teamplayerlinks')) {
    const playerId = num(l, 'playerid');
    const teamId = num(l, 'teamid');
    // First link wins; national-team rows come later in the table.
    if (playerId !== null && teamId !== null && !clubOf.has(playerId)) clubOf.set(playerId, teamId);
  }

  const dealsModel: DealsModel = buildDealsModel(
    rowsOf(tables, 'career_presignedcontract'),
    players,
    teamNames,
    nameOf,
    (p) => ageAt(num(p, 'birthdate'), gameDate.date),
  );

  const teamOverall = new Map<number, number>();
  for (const team of rowsOf(tables, 'teams')) {
    const id = num(team, 'teamid');
    const ovr = num(team, 'overallrating');
    if (id !== null && ovr !== null) teamOverall.set(id, ovr);
  }

  const transfers = findTargets(
    rowsOf(tables, 'players'),
    seniorRows,
    clubId,
    gameDate.date,
    synergyReport,
    affinityIndex(rowsOf(tables, 'player_grudgelove')),
    nameOf,
    clubOf,
    teamNames,
    eligibleClubs(rowsOf(tables, 'leagueteamlinks'), rowsOf(tables, 'leagues'), careerGender === 1),
    teamOverall,
    dealsModel,
    { gender: careerGender },
  );

  const leagueNameOf = new Map<number, string>();
  for (const l of rowsOf(tables, 'leagues')) {
    const id = num(l, 'leagueid');
    const nm = l['leaguename'];
    // The save styles domestic leagues "England Premier League (1)" — the
    // trailing division marker is noise on screen.
    if (id !== null && typeof nm === 'string') leagueNameOf.set(id, nm.replace(/ \(\d+\)$/, ''));
  }
  const leagueOfTeam = new Map<number, string>();
  for (const link2 of rowsOf(tables, 'leagueteamlinks')) {
    const teamId = num(link2, 'teamid');
    const leagueId = num(link2, 'leagueid');
    if (teamId !== null && leagueId !== null) {
      const nm = leagueNameOf.get(leagueId);
      if (nm) leagueOfTeam.set(teamId, nm);
    }
  }

  const loanAdvised = everyone
    .map((p) => {
      const hit = [p.advice, ...p.otherAdvice].find((a) => a.rule === 'R-03' || a.rule === 'R-11');
      return hit ? { playerId: p.playerId, ruleId: hit.rule as string, line: hit.line } : null;
    })
    .filter((x): x is { playerId: number; ruleId: string; line: string } => x !== null);

  const contractTeamOf = new Map<number, number>();
  for (const c of rowsOf(tables, 'career_playercontract')) {
    const pid = num(c, 'playerid');
    const tid = num(c, 'teamid');
    if (pid !== null && tid !== null) contractTeamOf.set(pid, tid);
  }

  const loans = buildLoans({
    loans: rowsOf(tables, 'playerloans'),
    clubId,
    youthTeamId: YOUTH_TEAM_ID,
    clubOf,
    teamNames,
    teams: rowsOf(tables, 'teams'),
    leagueOfTeam,
    eligibleClubs: eligibleClubs(rowsOf(tables, 'leagueteamlinks'), rowsOf(tables, 'leagues'), careerGender === 1),
    playerById: players,
    contractTeamOf,
    nameOf,
    ageOf: (p) => ageAt(num(p, 'birthdate'), gameDate.date),
    loanAdvised,
  });

  // Loan performance: the save records nothing about his matches at the loan
  // club, but his ratings still move in `players` — growth since the season
  // began is the honest signal, read from our own snapshots.
  if (input.store && input.careerId !== undefined) {
    for (const r of loans.out) {
      const first = (field: string): number | null => {
        const pts = input
          .store!.series(input.careerId!, r.playerId, field)
          .filter((p2) => p2.gameDate !== null && p2.gameDate >= seasonStartYmd && p2.value !== null);
        return pts.length ? pts[0]!.value : null;
      };
      const o0 = first('overallrating');
      const c0 = first('potential');
      r.overallDelta = r.overall !== null && o0 !== null ? r.overall - o0 : null;
      r.ceilingDelta = r.potential !== null && c0 !== null ? r.potential - c0 : null;
    }
  }

  const fmtYmd = (n: number | null): string | null =>
    n === null ? null : String(n).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

  // Scouts: real names in the save, judgement and experience separate. The
  // next-job suggestion is computed, not vibes: for each thin position, the
  // nation whose under-21 pool holds the most high-ceiling players *in this
  // world* is where a mission pays best.
  const nations = input.nations ?? new Map<number, string>();
  const nationName = (id: number | null): string | null =>
    id === null ? null : (nations.get(id) ?? `#${id}`);

  const thinSlots = transfers.gaps.filter((g) => g.severity !== 'none').map((g) => g.slot);
  const talentPool = new Map<string, { nation: string; count: number }>();
  for (const slot of thinSlots) {
    const byNation = new Map<number, number>();
    for (const p2 of worldRows) {
      if (slotOf(num(p2, 'preferredposition1')) !== slot) continue;
      const age = ageAt(num(p2, 'birthdate'), gameDate.date);
      const pot = num(p2, 'potential');
      const nat = num(p2, 'nationality');
      if (age === null || age > 21 || pot === null || pot < 84 || nat === null) continue;
      byNation.set(nat, (byNation.get(nat) ?? 0) + 1);
    }
    const best = [...byNation.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) talentPool.set(slot, { nation: nationName(best[0]) ?? `#${best[0]}`, count: best[1] });
  }

  const missionsByScout = new Map(
    rowsOf(tables, 'career_scoutmission').map((m) => [num(m, 'scoutid'), m]),
  );
  const scouts: ScoutView[] = rowsOf(tables, 'career_scouts').map((sc, index) => {
    const scoutId = num(sc, 'scoutid') ?? -1;
    const mission = missionsByScout.get(scoutId);
    const positions = mission
      ? [1, 2, 3, 4]
          .map((n) => num(mission, `preferredposition${n}`))
          .filter((v): v is number => v !== null && v >= 0)
          .map((code) => positionShort(code) ?? positionName(code))
      : [];

    const jobSlot = thinSlots[index % Math.max(1, thinSlots.length)];
    const pool = jobSlot ? talentPool.get(jobSlot) : undefined;
    const alreadyThere = jobSlot !== undefined && positions.includes(jobSlot);
    return {
      scoutId,
      name: [sc['firstname'], sc['lastname']].filter(Boolean).join(' ') || `Scout ${scoutId}`,
      nationality: nationName(num(sc, 'nationality')),
      // Stored 0-based, like skill moves: a stored 4 is the five-star scout the
      // game shows. Displaying the raw value undersold every scout by one star.
      knowledge: num(sc, 'knowledge') === null ? null : Math.min(5, num(sc, 'knowledge')! + 1),
      experience: num(sc, 'experience') === null ? null : Math.min(5, num(sc, 'experience')! + 1),
      mission: mission
        ? {
            positions,
            nation: nationName(num(mission, 'nationality')),
            returns: fmtYmd(num(mission, 'returningdate')),
            cost: num(mission, 'missioncost'),
          }
        : null,
      nextJob:
        jobSlot && pool && !alreadyThere
          ? `Next: ${jobSlot} in ${pool.nation} — ${pool.count} under-21s there with an 84+ ceiling in this world.`
          : jobSlot && !alreadyThere
            ? `Next: the squad is thin at ${jobSlot}.`
            : null,
    };
  });

  // Season-by-season record, straight from career_managerhistory.
  const seasons: SeasonRecord[] = rowsOf(tables, 'career_managerhistory')
    .map((r) => ({
      season: num(r, 'season') ?? 0,
      played: num(r, 'games_played') ?? 0,
      wins: num(r, 'wins') ?? 0,
      draws: num(r, 'draws') ?? 0,
      losses: num(r, 'losses') ?? 0,
      points: num(r, 'points'),
      position: num(r, 'tableposition'),
      goalsFor: num(r, 'goals_for'),
      goalsAgainst: num(r, 'goals_against'),
      leagueTrophies: num(r, 'leaguetrophies') ?? 0,
      cupTrophies: (num(r, 'domesticcuptrophies') ?? 0) + (num(r, 'continentalcuptrophies') ?? 0),
      bigBuy:
        typeof r['bigbuyplayername'] === 'string' && r['bigbuyplayername']
          ? { name: r['bigbuyplayername'], amount: num(r, 'bigbuyamount') ?? 0 }
          : null,
      bigSell:
        typeof r['bigsellplayername'] === 'string' && r['bigsellplayername']
          ? { name: r['bigsellplayername'], amount: num(r, 'bigsellamount') ?? 0 }
          : null,
    }))
    .sort((a, b) => a.season - b.season);

  const mi = rowsOf(tables, 'career_managerinfo')[0];
  // The manager's own record books: biggest win and loss, with dates and the
  // opponent — 13-0 belongs on a brag card, not in a hex dump.
  const scoreline = (kind: 'win' | 'loss') => {
    const user = num(mi, `big${kind}userscore`);
    const opp = num(mi, `big${kind}oppscore`);
    const oppTeam = num(mi, `big${kind}oppteamid`);
    const date = num(mi, `big${kind}date`);
    if (user === null || opp === null || date === null || date <= 20080101) return null;
    if (kind === 'win' && user === 0 && opp === 0) return null;
    return {
      userScore: user,
      oppScore: opp,
      opponent: oppTeam !== null ? (teamNames.get(oppTeam) ?? `team ${oppTeam}`) : 'unknown',
      date,
    };
  };
  const board = {
    reputation: num(mi, 'managerreputation'),
    totalEarnings: num(mi, 'totalearnings'),
    wage: num(mi, 'wage'),
    objectivesSet: [1, 2, 3].filter((n) => (num(mi, `seasonobjective${n}`) ?? 0) !== 0).length,
    competitions: rowsOf(tables, 'career_competitionprogress')
      .map((r) => ({
        name:
          typeof r['compshortname'] === 'string' && r['compshortname']
            ? (input.competitions?.get(r['compshortname']) ?? r['compshortname'])
            : (leagueNameOf.get(num(rowsOf(tables, 'career_users')[0], 'leagueid') ?? -1) ?? 'League campaign'),
        season: num(r, 'season') ?? 0,
        won: (num(r, 'hasteamwon') ?? 0) !== 0,
        result: num(r, 'cup_objective_result'),
        notStarted: num(r, 'stageid') === -1,
      }))
      .sort((a, b) => b.season - a.season),
    bigWin: scoreline('win'),
    bigLoss: scoreline('loss'),
  };

  const regens = buildRegenReport({
    players,
    links,
    teamNames,
    ourClubId: clubId,
    youthTeamId: YOUTH_TEAM_ID,
    loanedIds: loaned,
    gameDate: gameDate.date,
    nameOf,
    ageOf: (p) => ageAt(num(p, 'birthdate'), gameDate.date),
    tags: new Map(), // the tagging UI and store were removed
    store: input.store,
    careerId: input.careerId,
  });

  const mean = (values: (number | null)[]): number | null => {
    const present = values.filter((v): v is number => v !== null);
    return present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 10) / 10 : null;
  };

  const bySlot = new Map<string, PlayerView[]>();
  for (const p of senior) {
    const slot = p.positionShort ?? p.bestSlot ?? 'unknown';
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), p]);
  }

  const ageBands: { band: string; count: number }[] = [
    { band: 'Under 21', count: senior.filter((p) => p.age !== null && p.age < 21).length },
    { band: '21-25', count: senior.filter((p) => p.age !== null && p.age >= 21 && p.age <= 25).length },
    { band: '26-29', count: senior.filter((p) => p.age !== null && p.age >= 26 && p.age <= 29).length },
    { band: '30+', count: senior.filter((p) => p.age !== null && p.age >= 30).length },
  ];

  const stats: StatsView = {
    squadSize: senior.length,
    academySize: academy.length,
    meanOverall: mean(senior.map((p) => p.overall)),
    meanAge: mean(senior.map((p) => p.age)),
    meanPotential: mean(senior.map((p) => p.potential)),
    totalMinutes: senior.reduce((sum, p) => sum + (p.minutesThisSeason ?? 0), 0),
    wageBill: wages.totalBill,
    byPosition: [...bySlot.entries()]
      .map(([slot, list]) => ({
        slot,
        count: list.length,
        meanOverall: mean(list.map((p) => p.overall)),
        meanAge: mean(list.map((p) => p.age)),
      }))
      .sort((a, b) => b.count - a.count),
    topScorers: senior
      .filter((p) => (p.goals ?? 0) > 0)
      .sort((a, b) => (b.goals ?? 0) - (a.goals ?? 0))
      .slice(0, 8)
      .map((p) => ({ playerId: p.playerId, name: p.name, goals: p.goals! })),
    bestRated: senior
      .filter((p) => p.averageRating !== null)
      .sort((a, b) => b.averageRating! - a.averageRating!)
      .slice(0, 8)
      .map((p) => ({ playerId: p.playerId, name: p.name, rating: p.averageRating!, apps: p.appearances ?? 0 })),
    mostMinutes: senior
      .filter((p) => (p.minutesThisSeason ?? 0) > 0)
      .sort((a, b) => (b.minutesThisSeason ?? 0) - (a.minutesThisSeason ?? 0))
      .slice(0, 8)
      .map((p) => ({ playerId: p.playerId, name: p.name, minutes: p.minutesThisSeason! })),
    biggestRisers: everyone
      .filter((p) => (p.overallSeasonDelta ?? 0) !== 0)
      .sort((a, b) => (b.overallSeasonDelta ?? 0) - (a.overallSeasonDelta ?? 0))
      .slice(0, 8)
      .map((p) => ({ playerId: p.playerId, name: p.name, delta: p.overallSeasonDelta! })),
    ceilingWatch: everyone
      .filter((p) => (p.potentialSeasonDelta ?? 0) !== 0)
      .sort((a, b) => (a.potentialSeasonDelta ?? 0) - (b.potentialSeasonDelta ?? 0))
      .map((p) => ({
        playerId: p.playerId,
        name: p.name,
        delta: p.potentialSeasonDelta!,
        minutes: p.minutesThisSeason,
        age: p.age,
        squad: p.squad,
      })),
    ageProfile: ageBands,
  };

  if (matchday.calibration.meanAbsoluteError !== null && matchday.calibration.meanAbsoluteError > 1) {
    warnings.push(
      `Fit weights are off by ${matchday.calibration.meanAbsoluteError} on average against the game's ratings — ` +
        'treat fit-based advice as provisional until they are calibrated (spec.md F-1).',
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    club: { id: clubId, name: (club?.['teamname'] as string) ?? null, overall: num(club, 'overallrating') },
    manager: [user?.['firstname'], user?.['surname']].filter(Boolean).join(' ') || null,
    season: num(user, 'seasoncount'),
    gameDate: gameDate.date,
    gameDateBasis: gameDate.basis,
    gameDateIsEstimate: true,
    snapshots: input.store && input.careerId !== undefined ? input.store.snapshots(input.careerId).length : 0,
    names: {
      squad: covered(senior),
      academy: covered(academy),
      tableSize: input.nameTableSize ?? 0,
    },
    senior,
    academy,
    alerts,
    matchday,
    synergy,
    transfers,
    loans,
    scouts,
    board,
    deals: { observed: dealsModel.deals, sample: dealsModel.sample, modelled: dealsModel.estimate !== null },
    seasons,
    regens,
    wages: {
      ...wages,
      assessmentList: [...wages.assessments.values()].map((a) => ({
        playerId: a.playerId,
        verdict: a.verdict,
        note: a.note,
        wage: a.wage,
        peerMedian: a.peerMedian,
      })),
    },
    stats,
    warnings,
  };
}

/** Same estimate as the store uses (spec.md §9 D-1). */
function estimateDate(tables: Tables): { date: number | null; basis: string | null } {
  const sources: [string, string][] = [
    ['persistent_events', 'eventdate'],
    ['career_playermatchratinghistory', 'date'],
    ['career_presignedcontract', 'signeddate'],
    ['career_playercontract', 'last_status_change_date'],
  ];
  let best: number | null = null;
  let basis: string | null = null;
  for (const [table, field] of sources) {
    for (const row of rowsOf(tables, table)) {
      const value = num(row, field);
      if (value === null || value < 20240101 || value > 20500101) continue;
      if (best === null || value > best) {
        best = value;
        basis = `${table}.${field}`;
      }
    }
  }
  return { date: best, basis };
}
