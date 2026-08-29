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
  allGroupsFor,
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
import { MODEL, allFits, bestFit, calibrationReport, fitFor, slotOf, type Slot } from './fit.ts';
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
  attributePercentile,
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
import { eaValue, type EaValueBand } from './eaValue.ts';
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
  /** surge / rise / flat / dip / fall — season delta plus the last month's slope. */
  trend: 'surge' | 'rise' | 'flat' | 'dip' | 'fall' | null;
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
  /** Nation name from data/nations_fc26.csv; null when the id is unmapped. */
  nation: string | null;
  standout: { attr: string; value: number; percentile: number }[];
  /** Where growth buys the most fit: heavy-weighted attributes below the position's 55th percentile. */
  developFocus: { attr: string; value: number; percentile: number }[];
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
  /** The career's own currency symbol, from career_managerpref.currency. */
  currency: string;
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
  /**
   * Every club in your own league, measured line by line. The save has no
   * fixture list (verified — §1.7), so it cannot say who is next; it does
   * hold every opponent's squad, so pick the club you are about to play and
   * read how the lines compare.
   */
  opponents: {
    teamId: number;
    name: string;
    league: string;
    /** The league's nation, for the flag-first picker. */
    nation: string;
    /** True for clubs in your own division. */
    home: boolean;
    /** Mean overall of the best plausible XI (best GK + top ten outfield). */
    overall: number | null;
    gk: number | null;
    def: number | null;
    mid: number | null;
    att: number | null;
    threats: { name: string; pos: string | null; overall: number }[];
    pace: { name: string; sprint: number } | null;
  }[];
  seasons: SeasonRecord[];
  regens: RegenReport;
  wages: WageReport & { assessmentList: { playerId: number; verdict: string; note: string; wage: number | null; peerMedian: number | null }[] };
  stats: StatsView;
  /** The user's own league table, straight from leagueteamlinks. */
  leagueTable: {
    league: string | null;
    rows: {
      teamId: number;
      name: string;
      position: number | null;
      prevPosition: number | null;
      movedDivision: 'up' | 'down' | null;
      form: number | null;
      formLong: number | null;
      lastResult: number | null;
      played: number;
      wins: number;
      draws: number;
      losses: number;
      gf: number;
      ga: number;
      gd: number;
      points: number;
      isUser: boolean;
      champion: boolean;
      unbeaten: boolean;
    }[];
    /** False right after a season rolls, before any league match is recorded. */
    started: boolean;
  };
  /** Who is out, for how long, and who steps in — the game's first screen. */
  treatment: {
    injured: {
      playerId: number;
      name: string;
      pos: string | null;
      overall: number | null;
      /** career_playerlastgrowth.injuryduration, in days. Null when unrecorded. */
      daysOut: number | null;
      replacement: { playerId: number; name: string; fit: number } | null;
    }[];
    suspended: {
      playerId: number;
      name: string;
      pos: string | null;
      replacement: { playerId: number; name: string; fit: number } | null;
    }[];
  };
  calendar: {
    /** Transfer windows from career_calendar — the one live thing in that table. */
    windows: { label: string; opens: string; closes: string; openNow: boolean | null }[];
    /** persistent_events, newest first. Event ids are the game's own, unmapped. */
    events: { date: number; eventId: number; team1: string | null; team2: string | null; player: string | null }[];
  };
  coaching: {
    /** Every real manager in this world, star-rated by the game itself. */
    market: {
      managerId: number;
      name: string;
      club: string | null;
      league: string | null;
      nation: string | null;
      age: number | null;
      stars: number | null;
      /** Which game their club belongs to: men's, women's, or unlinked. */
      game: 'men' | 'women' | 'other';
    }[];
    /** Best-rated managers not at your club — the Live Editor target-coach pool. */
    targets: { managerId: number; name: string; club: string | null; stars: number | null; age: number | null }[];
  };
  finances: {
    transferBudget: number | null;
    wageBudget: number | null;
    startTransferBudget: number | null;
    startWageBudget: number | null;
    clubWorth: number | null;
    profitability: number | null;
    domesticPrestige: number | null;
    internationalPrestige: number | null;
    youthDevelopment: number | null;
    wageBill: number;
    managerWage: number | null;
    totalEarnings: number | null;
    financialStrictness: number | null;
  };
  /** What this world would pay for each of your players, from its own observed deals. */
  sellValues: {
    modelled: boolean;
    sample: number;
    rows: {
      playerId: number;
      name: string;
      age: number | null;
      overall: number | null;
      potential: number | null;
      wage: number | null;
      contractMonths: number | null;
      low: number | null;
      mid: number | null;
      high: number | null;
      /** True when the player is priced beyond any deal this world has done. */
      offMarket: boolean;
      /** EA-style valuation band (eaValue.ts) — the game's own idea of fair. */
      ea: EaValueBand | null;
    }[];
  };
  /**
   * Prospects a scout has delivered into the academy that you have not signed.
   * Full player records — they deserve the same reading as anyone else — plus
   * the call on whether to sign them.
   */
  academyReports: (PlayerView & { report: { verdict: 'sign' | 'watch' | 'pass'; why: string } })[];
  /**
   * Descriptive profiles for players outside your squad — everyone on the
   * shopping list and everyone the game has shortlisted. Enough to open a real
   * card on a target: the attribute sheet, the PlayStyles, what he is elite at.
   * No advice: the rules are about YOUR squad, and pretending otherwise would
   * be inventing a relationship that does not exist.
   */
  scoutProfiles: {
    playerId: number;
    name: string;
    nation: string | null;
    age: number | null;
    positionShort: string | null;
    preferredPositions: string[];
    overall: number | null;
    potential: number | null;
    foot: 'Left' | 'Right' | null;
    height: number | null;
    weight: number | null;
    skillMoves: number | null;
    weakFoot: number | null;
    groups: AttributeGroupView[];
    playStyles: PlayStyle[];
    standout: { attr: string; value: number; percentile: number }[];
    teamName: string | null;
    league: string | null;
    contractMonths: number | null;
    wage: number | null;
    ea: EaValueBand | null;
  }[];
  /**
   * The story ledger: what happened and when we first saw it, newest first.
   * Empty until the store has watched a save or two — history cannot be
   * back-filled from a single file, and pretending otherwise would date every
   * event to today.
   */
  story: {
    key: string;
    kind: string;
    season: number | null;
    title: string;
    detail: string | null;
    gameDate: number | null;
  }[];
  /** The transfer shortlist exactly as the game saved it (career blob `mssm`). */
  shortlistIngame: {
    readable: boolean;
    date: number | null;
    players: {
      playerId: number;
      name: string;
      club: string | null;
      league: string | null;
      nation: string | null;
      age: number | null;
      overall: number | null;
      potential: number | null;
      /** What this world's own deals would pay (deals model). */
      fee: { low: number; mid: number; high: number } | null;
      /** EA-style valuation band — the game's own idea of fair. */
      ea: EaValueBand | null;
    }[];
  };
  warnings: string[];
}

export interface MatchdayView {
  saved: SavedXI | null;
  recommended: XI | null;
  diff: SelectionDiff[];
  shapes: ShapeComparison[];
  /** Every saved team sheet, scored: mean anchored fit of its XI in its own positions. */
  sheets: { name: string; shapeName: string | null; players: number; today: number | null }[];
  /** Packed role codes (roleId*64+focus) per saved-XI player; names unmapped (R-1). */
  sheetRoles: { playerId: number; code: number | null; roleId: number | null; focus: number | null }[];
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
  /** True while the scout is away on a trip that has not returned yet. */
  away: boolean;
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
  /** In-game shortlist read from the save's career blob; null when unreadable. */
  shortlist?: { ids: number[]; date: number | null } | null;
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
  // The academy squad holds two different things, and the difference is the
  // contract (verified 2026-08-29, three reports delivered: 31 youth links =
  // 13 signed prospects, each with a contract and a career_youthplayers row,
  // and 18 report arrivals with neither, wearing jersey 99).
  //
  //   signed  — has a contract: he is yours, and the youth table tracks him
  //   report  — no contract: a scout delivered him, and signing is the act
  //             that writes the contract
  //
  // Treating them as one list put eighteen strangers in the academy and left
  // Scout Reports empty.
  const academySquadIds = squadOf(YOUTH_TEAM_ID);
  const academyIds = academySquadIds.filter((id) => contracts.has(id));
  const reportIds = academySquadIds.filter((id) => !contracts.has(id));


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
    const seasonSeries = (field: string) =>
      input.store && input.careerId !== undefined
        ? input.store
            .series(input.careerId!, id, field)
            .filter((p2) => p2.gameDate !== null && p2.value !== null && p2.gameDate >= seasonStartYmd)
        : [];
    const potentialPoints = seasonSeries('potential');
    const ceilingDrift =
      potential !== null && potentialPoints.length > 0 ? potential - potentialPoints[0]!.value! : null;

    // Season growth, from the same anchor. The save's own growth-baseline
    // table MOVES mid-season (observed: a player at 77 -> 81 showed +3, then
    // at 82 showed +2 — the baseline had rolled from 78 to 80), so it cannot
    // mean "since the season began". Our earliest snapshot since July 1 can.
    const overallPoints = seasonSeries('overallrating');
    const snapshotSeasonDelta =
      overall !== null && overallPoints.length > 0 ? overall - overallPoints[0]!.value! : null;
    // Recent slope: the last month of snapshots, for the trend arrow.
    const recentPoints = overallPoints.slice(-6);
    const recentDelta =
      recentPoints.length >= 2 ? recentPoints[recentPoints.length - 1]!.value! - recentPoints[0]!.value! : null;
    const seasonDelta = snapshotSeasonDelta ?? (overall !== null && baseOverall !== null ? overall - baseOverall : null);
    /** Five states for the trend arrow: strong rise, rise, flat, dip, fall. */
    const trend =
      seasonDelta === null
        ? null
        : seasonDelta >= 3 || (recentDelta ?? 0) >= 2
          ? 'surge'
          : seasonDelta >= 1
            ? 'rise'
            : seasonDelta <= -3 || (recentDelta ?? 0) <= -2
              ? 'fall'
              : seasonDelta <= -1
                ? 'dip'
                : 'flat';

    const groups = allGroupsFor(player).map((group) => {
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
      overallSeasonDelta: seasonDelta,
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

      overallSeasonDelta: seasonDelta,
      trend,
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
      nation: (() => {
        const natId = num(player, 'nationality');
        return natId !== null ? ((input.nations ?? new Map()).get(natId) ?? null) : null;
      })(),
      standout: standoutAttributes(worldStats, slotOf(num(player, 'preferredposition1')), player),
      developFocus: (() => {
        const slot = slotOf(num(player, 'preferredposition1'));
        if (!slot || (potential ?? 0) - (overall ?? 99) < 2) return [];
        return Object.entries(MODEL[slot].weights)
          .map(([attr, weight]) => {
            const value = num(player, attr);
            const pct = attributePercentile(worldStats, slot, attr, value);
            if (value === null || pct === null || weight < 0.04 || pct >= 65) return null;
            return { attr, value, percentile: pct, score: weight * (65 - pct) };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map(({ attr, value, percentile }) => ({ attr, value, percentile }));
      })(),
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
    // Sheet role codes are packed roleId*64+focus (derived from the save:
    // every observed code has a remainder under 64). Names are unmapped (R-1);
    // the pairs are shown so the map can be built by reading the game screen.
    sheetRoles: (savedXI?.players ?? []).map((pl) => ({
      playerId: pl.playerId,
      code: pl.roleCode,
      roleId: pl.roleCode !== null ? Math.floor(pl.roleCode / 64) : null,
      focus: pl.roleCode !== null ? pl.roleCode % 64 : null,
    })),
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

  // The fee guide the user asked for is EA's own idea of fair, not just what
  // this world has happened to pay — attach the EA band to every target.
  for (const t2 of transfers.targets as unknown as { playerId: number; ea?: EaValueBand | null }[]) {
    const row = players.get(t2.playerId);
    t2.ea = row
      ? eaValue(
          num(row, 'overallrating'),
          ageAt(num(row, 'birthdate'), gameDate.date),
          num(row, 'potential'),
          num(row, 'preferredposition1'),
        )
      : null;
  }

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
      away:
        mission !== undefined &&
        num(mission, 'returningdate') !== null &&
        gameDate.date !== null &&
        num(mission, 'returningdate')! > gameDate.date,
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

  // Opponent scout: line-by-line squad measures for every club in the league.
  const userLeagueId = (() => {
    for (const l of rowsOf(tables, 'leagueteamlinks')) {
      if (num(l, 'teamid') === clubId) return num(l, 'leagueid');
    }
    return null;
  })();
  // Every club in every signable domestic league — you might face anyone in
  // Europe, so the scout is not fenced to your own division.
  const scoutClubs = eligibleClubs(rowsOf(tables, 'leagueteamlinks'), rowsOf(tables, 'leagues'), careerGender === 1);
  // The signable set includes reserve competitions ("Youth Squad League") that
  // no fixture list would ever pit you against — the scout skips them.
  const leagueCountry = new Map<number, number>();
  const youthLeagues = new Set<number>();
  for (const l of rowsOf(tables, 'leagues')) {
    const id = num(l, 'leagueid');
    if (id === null) continue;
    const c = num(l, 'countryid');
    if (c !== null) leagueCountry.set(id, c);
    const nm = l['leaguename'];
    if (typeof nm === 'string' && /youth|reserve/i.test(nm)) youthLeagues.add(id);
  }
  const leagueIdOfTeam = new Map<number, number>();
  for (const l of rowsOf(tables, 'leagueteamlinks')) {
    const t = num(l, 'teamid');
    const lg = num(l, 'leagueid');
    if (t !== null && lg !== null && scoutClubs.has(t) && !youthLeagues.has(lg)) leagueIdOfTeam.set(t, lg);
  }
  const playersByClub = new Map<number, Row[]>();
  for (const [pid, teamId] of clubOf) {
    if (!leagueIdOfTeam.has(teamId)) continue;
    const row = players.get(pid);
    if (!row) continue;
    const list = playersByClub.get(teamId) ?? [];
    list.push(row);
    playersByClub.set(teamId, list);
  }
  const groupOf = (code: number | null): 'gk' | 'def' | 'mid' | 'att' | null =>
    code === null ? null : code === 0 ? 'gk' : code <= 8 ? 'def' : code <= 19 ? 'mid' : 'att';
  const meanOf = (xs: (number | null)[]): number | null => {
    const ok = xs.filter((x): x is number => x !== null);
    return ok.length ? Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 10) / 10 : null;
  };
  const opponents = [...playersByClub.entries()]
    .map(([teamId, roster]) => {
      const rated = roster
        .map((r) => ({
          r,
          overall: num(r, 'overallrating') ?? 0,
          group: groupOf(num(r, 'preferredposition1')),
        }))
        .sort((a, b) => b.overall - a.overall);
      const top = (g: string, n: number) => rated.filter((x) => x.group === g).slice(0, n);
      const gk = top('gk', 1);
      const xi = [...gk, ...rated.filter((x) => x.group !== 'gk').slice(0, 10)];
      const fastest = roster
        .map((r) => ({ r, sprint: num(r, 'sprintspeed') ?? 0 }))
        .sort((a, b) => b.sprint - a.sprint)[0];
      return {
        teamId,
        name: teamNames.get(teamId) ?? `team ${teamId}`,
        league: leagueNameOf.get(leagueIdOfTeam.get(teamId) ?? -1) ?? 'Unknown league',
        nation:
          (input.nations ?? new Map()).get(leagueCountry.get(leagueIdOfTeam.get(teamId) ?? -1) ?? -1) ??
          'International',
        home: leagueIdOfTeam.get(teamId) === userLeagueId,
        overall: meanOf(xi.map((x) => x.overall)),
        gk: meanOf(gk.map((x) => x.overall)),
        def: meanOf(top('def', 4).map((x) => x.overall)),
        mid: meanOf(top('mid', 4).map((x) => x.overall)),
        att: meanOf(top('att', 3).map((x) => x.overall)),
        threats: rated.slice(0, 3).map((x) => ({
          name: nameOf(num(x.r, 'playerid') ?? -1),
          pos: positionShort(num(x.r, 'preferredposition1')),
          overall: x.overall,
        })),
        pace: fastest && fastest.sprint > 0 ? { name: nameOf(num(fastest.r, 'playerid') ?? -1), sprint: fastest.sprint } : null,
      };
    })
    .sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));

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
      .map((r) => {
        // Codes name themselves through competitions.csv. Of the blank-code
        // rows, only the one recurring every season (compobjid 808 here) is
        // the league campaign; any other blank is an unmapped competition and
        // says so instead of wearing the league's name.
        const code = typeof r['compshortname'] === 'string' ? r['compshortname'] : '';
        const objId = num(r, 'compobjid');
        const name = code
          ? (input.competitions?.get(code) ?? code)
          : objId === 808
            ? (leagueNameOf.get(num(rowsOf(tables, 'career_users')[0], 'leagueid') ?? -1) ?? 'League campaign')
            : (input.competitions?.get(`OBJ${objId}`) ?? `Competition #${objId}~`);
        return {
          name,
          season: num(r, 'season') ?? 0,
          won: (num(r, 'hasteamwon') ?? 0) !== 0,
          result: num(r, 'cup_objective_result'),
          notStarted: num(r, 'stageid') === -1,
        };
      })
      .sort((a, b) => b.season - a.season),
    bigWin: scoreline('win'),
    bigLoss: scoreline('loss'),
  };

  // --- the league table, straight from leagueteamlinks -----------------------
  // Positions persist across the summer; W/D/L and points reset when the season
  // rolls, so "played" is their sum rather than nummatchesplayed (which is
  // observed stale at a season boundary).
  const leagueRows = rowsOf(tables, 'leagueteamlinks')
    .filter((l) => num(l, 'leagueid') === userLeagueId)
    .map((l) => {
      const teamId = num(l, 'teamid') ?? -1;
      const wins = (num(l, 'homewins') ?? 0) + (num(l, 'awaywins') ?? 0);
      const draws = (num(l, 'homedraws') ?? 0) + (num(l, 'awaydraws') ?? 0);
      const played = wins + draws + ((num(l, 'homelosses') ?? 0) + (num(l, 'awaylosses') ?? 0));
      const gf = (num(l, 'homegf') ?? 0) + (num(l, 'awaygf') ?? 0);
      const ga = (num(l, 'homega') ?? 0) + (num(l, 'awayga') ?? 0);
      // A club that changed division has no comparable finish: Wolves coming up
      // as Championship winners read as "▼19 champions" against the Premier
      // League table, which is nonsense. Say "promoted" instead.
      const prevLeague = num(l, 'prevleagueid');
      const league = num(l, 'leagueid');
      const moved = prevLeague !== null && league !== null && prevLeague !== league;
      return {
        teamId,
        name: teamNames.get(teamId) ?? `team ${teamId}`,
        position: num(l, 'currenttableposition'),
        /** Where they finished last season — the movement arrow's other end. */
        prevPosition: moved ? null : num(l, 'previousyeartableposition'),
        /** 'up' or 'down' when the club changed division over the summer. */
        movedDivision: (moved ? ((prevLeague ?? 0) > (league ?? 0) ? 'up' : 'down') : null) as 'up' | 'down' | null,
        /** The game's own 0-100 recent-form number, which IS maintained live. */
        form: num(l, 'teamshortform'),
        /** Longer-run form on the same scale. */
        formLong: num(l, 'teamlongform'),
        /** 0 loss, 1 draw, 2 win — the last result, live. */
        lastResult: num(l, 'lastgameresult'),
        played,
        wins,
        draws,
        losses: played - wins - draws,
        gf,
        ga,
        gd: gf - ga,
        points: num(l, 'points') ?? 0,
        isUser: teamId === clubId,
        champion: (num(l, 'champion') ?? 0) !== 0 && !moved,
        unbeaten: (num(l, 'unbeatenleague') ?? 0) !== 0,
      };
    })
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || b.points - a.points);
  const leagueTable = {
    league: leagueNameOf.get(userLeagueId ?? -1) ?? null,
    rows: leagueRows,
    /**
     * Whether the save is keeping a live results record at all.
     *
     * It is not: FC 26 writes points, wins, draws, losses and goals into
     * `leagueteamlinks` only at a season boundary, and leaves them at zero
     * with a stale `nummatchesplayed` all season long (verified 2026-08-29 —
     * two league matches played, every club still reading zero). What IS
     * maintained live is the position and the form numbers, so those are what
     * the table shows rather than a wall of dashes.
     */
    started: leagueRows.some((r) => r.played > 0 || r.points > 0),
  };

  // --- treatment room: who is out and who steps in ----------------------------
  const injuryDays = new Map<number, number>();
  for (const g of rowsOf(tables, 'career_playerlastgrowth')) {
    const pid = num(g, 'playerid');
    const days = num(g, 'injuryduration');
    if (pid !== null && days !== null && days > 0) injuryDays.set(pid, days);
  }
  const standIn = (outId: number): { playerId: number; name: string; fit: number } | null => {
    const row = players.get(outId);
    const slot = row ? slotOf(num(row, 'preferredposition1')) : null;
    if (!slot) return null;
    let best: { playerId: number; name: string; fit: number } | null = null;
    for (const r of seniorRows) {
      const pid = num(r, 'playerid')!;
      if (pid === outId || availability.has(pid)) continue;
      const fit = fitFor(r, slot)?.value ?? null;
      if (fit !== null && (best === null || fit > best.fit)) {
        best = { playerId: pid, name: nameOf(pid), fit: Math.round(fit * 10) / 10 };
      }
    }
    return best;
  };
  const treatment = {
    injured: [...availability.entries()]
      .filter(([, reason]) => reason === 'injured')
      .map(([pid]) => ({
        playerId: pid,
        name: nameOf(pid),
        pos: positionShort(num(players.get(pid), 'preferredposition1')),
        overall: num(players.get(pid), 'overallrating'),
        daysOut: injuryDays.get(pid) ?? null,
        replacement: standIn(pid),
      })),
    suspended: [...availability.entries()]
      .filter(([, reason]) => reason === 'suspended')
      .map(([pid]) => ({
        playerId: pid,
        name: nameOf(pid),
        pos: positionShort(num(players.get(pid), 'preferredposition1')),
        replacement: standIn(pid),
      })),
  };

  // --- calendar: transfer windows and the world's event feed ------------------
  const cal = rowsOf(tables, 'career_calendar')[0];
  const mmdd = (n: number | null): string =>
    n === null ? '—' : `${String(Math.floor(n / 100)).padStart(2, '0')}-${String(n % 100).padStart(2, '0')}`;
  const nowMmdd = gameDate.date !== null ? gameDate.date % 10000 : null;
  const windowOpen = (start: number | null, end: number | null): boolean | null => {
    if (start === null || end === null || nowMmdd === null) return null;
    return start <= end ? nowMmdd >= start && nowMmdd <= end : nowMmdd >= start || nowMmdd <= end;
  };
  const calendar = {
    windows: [
      {
        label: 'Summer window',
        opens: mmdd(num(cal, 'transferwindowstart1')),
        closes: mmdd(num(cal, 'transferwindowend1')),
        openNow: windowOpen(num(cal, 'transferwindowstart1'), num(cal, 'transferwindowend1')),
      },
      {
        label: 'Winter window',
        opens: mmdd(num(cal, 'transferwindowstart2')),
        closes: mmdd(num(cal, 'transferwindowend2')),
        openNow: windowOpen(num(cal, 'transferwindowstart2'), num(cal, 'transferwindowend2')),
      },
    ],
    events: rowsOf(tables, 'persistent_events')
      .map((e) => ({
        date: num(e, 'eventdate') ?? 0,
        eventId: num(e, 'eventid') ?? -1,
        team1: teamNames.get(num(e, 'team1id') ?? -1) ?? null,
        team2: teamNames.get(num(e, 'team2id') ?? -1) ?? null,
        player: (num(e, 'player1id') ?? -1) > 0 ? nameOf(num(e, 'player1id')!) : null,
      }))
      .filter((e) => e.date >= 20200101)
      .sort((a, b) => b.date - a.date)
      .slice(0, 14),
  };

  // --- the manager market -----------------------------------------------------
  // manager.starrating stores IEEE-754 float bits (1082130432 is 4.0); decoded
  // and verified against known managers (Arteta 4.5, Emery 4.0).
  const starOf = (raw: number | null): number | null => {
    if (raw === null) return null;
    if (raw >= 0 && raw <= 5) return raw;
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(raw >>> 0, 0);
    const f = buf.readFloatLE(0);
    return f >= 0 && f <= 5 ? Math.round(f * 2) / 2 : null;
  };
  const teamGender = new Map<number, number>();
  for (const tm of rowsOf(tables, 'teams')) {
    const id = num(tm, 'teamid');
    if (id !== null) teamGender.set(id, num(tm, 'gender') ?? 0);
  }
  const market = rowsOf(tables, 'manager')
    .map((m) => {
      const teamId = num(m, 'teamid');
      const nameStr =
        (typeof m['commonname'] === 'string' && m['commonname']) ||
        [m['firstname'], m['surname']].filter((v) => typeof v === 'string' && v).join(' ');
      const game: 'men' | 'women' | 'other' =
        teamId !== null && teamGender.has(teamId)
          ? teamGender.get(teamId) === 1
            ? 'women'
            : 'men'
          : 'other';
      return {
        managerId: num(m, 'managerid') ?? -1,
        name: nameStr || `manager ${num(m, 'managerid')}`,
        club: teamNames.get(teamId ?? -1) ?? null,
        league: teamId !== null ? (leagueOfTeam.get(teamId) ?? null) : null,
        nation: nationName(num(m, 'nationality')),
        age: ageAt(num(m, 'birthdate'), gameDate.date),
        stars: starOf(num(m, 'starrating')),
        game,
        teamId,
      };
    })
    .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || (a.age ?? 99) - (b.age ?? 99));
  const coaching = {
    market: market.map(({ teamId: _t, ...rest }) => rest),
    // Poachable picks: highest-rated managers employed at clubs in this
    // career's own leagues (national coaches and the other gender's game are
    // in the market list, not here), youngest first among equals.
    targets: market
      .filter((m) => m.teamId !== clubId && m.teamId !== null && leagueIdOfTeam.has(m.teamId) && (m.stars ?? 0) >= 4)
      .slice(0, 8)
      .map((m) => ({ managerId: m.managerId, name: m.name, club: m.club, stars: m.stars, age: m.age })),
  };

  // --- finances ---------------------------------------------------------------
  // Budgets read zero in every observed save (spec.md); zeros are shown as the
  // save holds them, labelled, never invented.
  const pref = rowsOf(tables, 'career_managerpref')[0];
  const nz = (v: number | null): number | null => (v === null || v === 0 ? null : v);
  const finances = {
    transferBudget: nz(num(pref, 'transferbudget')),
    wageBudget: nz(num(pref, 'wagebudget')),
    startTransferBudget: nz(num(pref, 'startofseasontransferbudget')),
    startWageBudget: nz(num(pref, 'startofseasonwagebudget')),
    clubWorth: num(club, 'clubworth'),
    profitability: num(club, 'profitability'),
    domesticPrestige: num(club, 'domesticprestige'),
    internationalPrestige: num(club, 'internationalprestige'),
    youthDevelopment: num(club, 'youthdevelopment'),
    wageBill: wages.totalBill,
    managerWage: num(mi, 'wage'),
    totalEarnings: num(mi, 'totalearnings'),
    financialStrictness: num(pref, 'boardfinancialstrictness'),
  };

  // --- sell values: this world's own market, applied to your own squad --------
  const sellValues = {
    modelled: dealsModel.estimate !== null,
    sample: dealsModel.sample,
    rows: senior
      .map((p) => {
        const est =
          dealsModel.estimate && p.overall !== null && p.age !== null && p.potential !== null
            ? dealsModel.estimate(p.overall, p.age, p.potential)
            : null;
        return {
          playerId: p.playerId,
          name: p.name,
          age: p.age,
          overall: p.overall,
          potential: p.potential,
          wage: p.wage,
          contractMonths: p.contractMonths,
          low: est?.low ?? null,
          mid: est?.mid ?? null,
          high: est?.high ?? null,
          offMarket: dealsModel.estimate !== null && est === null,
          ea: eaValue(p.overall, p.age, p.potential, p.positionCode),
        };
      })
      .sort((a, b) => (b.ea?.value ?? b.mid ?? 0) - (a.ea?.value ?? a.mid ?? 0)),
  };

  // --- the in-game shortlist (career blob mssm) -------------------------------
  const shortlistIngame = {
    readable: input.shortlist !== null && input.shortlist !== undefined,
    date: input.shortlist?.date ?? null,
    players: (input.shortlist?.ids ?? []).map((pid) => {
      const row = players.get(pid);
      // Prefer the domestic-club link: a shortlisted international's first
      // link row can be his national team, which is not where you'd bid.
      const teamId =
        rowsOf(tables, 'teamplayerlinks')
          .filter((l) => num(l, 'playerid') === pid)
          .map((l) => num(l, 'teamid'))
          .find((tid): tid is number => tid !== null && leagueIdOfTeam.has(tid)) ??
        clubOf.get(pid) ??
        null;
      const est =
        dealsModel.estimate && row
          ? dealsModel.estimate(
              num(row, 'overallrating') ?? 0,
              ageAt(num(row, 'birthdate'), gameDate.date) ?? 25,
              num(row, 'potential') ?? 0,
            )
          : null;
      return {
        playerId: pid,
        name: nameOf(pid),
        club: teamNames.get(teamId ?? -1) ?? null,
        league: teamId !== null ? (leagueOfTeam.get(teamId) ?? null) : null,
        nation: nationName(num(row, 'nationality')),
        age: ageAt(num(row, 'birthdate'), gameDate.date),
        overall: num(row, 'overallrating'),
        potential: num(row, 'potential'),
        fee: est ? { low: est.low, mid: est.mid, high: est.high } : null,
        ea: row
          ? eaValue(
              num(row, 'overallrating'),
              ageAt(num(row, 'birthdate'), gameDate.date),
              num(row, 'potential'),
              num(row, 'preferredposition1'),
            )
          : null,
      };
    }),
  };

  // --- scout-report prospects: delivered, not yet signed -----------------------
  // `career_youthplayers` is a WORLD table: it carries youth rows for players
  // at other clubs and in the free-agent pool too, so "has a youth row and no
  // contract" catches strangers (2026-08-29: it surfaced a Belgian free agent
  // while all three scouts were away on Jamaica/Bulgaria/Brazil trips — a
  // false positive the user caught immediately).
  //
  // The signal that actually holds: the report lands the prospect in YOUR
  // academy squad, and signing him is what writes the contract. So an unsigned
  // report is a youth-team link with no contract row. Every one of the 13
  // signed prospects in the dev save has a contract; a pending report has none.
  const academyPotentials = academy.map((p2) => p2.potential ?? 0).sort((a, b) => a - b);
  const academyMedianPot = academyPotentials.length
    ? academyPotentials[Math.floor(academyPotentials.length / 2)]!
    : null;
  const thinSlotSet = new Set(transfers.gaps.filter((g) => g.severity !== 'none').map((g) => g.slot));
  const academyReports = reportIds
    .map((pid) => {
      const view = build(pid, 'academy');
      if (!view) return null;
      const pot = view.potential;
      const slot = view.positionShort;
      const thin = slot !== null && thinSlotSet.has(slot as never);
      const aboveAcademy = pot !== null && academyMedianPot !== null && pot >= academyMedianPot;
      let verdict: 'sign' | 'watch' | 'pass';
      let why: string;
      if (pot !== null && (pot >= 84 || (aboveAcademy && thin))) {
        verdict = 'sign';
        why =
          pot >= 84
            ? `A ${pot} ceiling is first-team material — sign him before the report lapses.`
            : `Ceiling ${pot} beats your academy median of ${academyMedianPot}, and ${slot} is thin.`;
      } else if (pot !== null && academyMedianPot !== null && pot < academyMedianPot - 4 && !thin) {
        verdict = 'pass';
        why = `Ceiling ${pot} sits under everything already in the academy (median ${academyMedianPot}) at a position you already cover.`;
      } else {
        verdict = 'watch';
        why = `${pot ?? 'An unknown'} ceiling — worth a place only if this intake stays thin.`;
      }
      return { ...view, report: { verdict, why } };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (b.potential ?? 0) - (a.potential ?? 0));

  // --- scout profiles for the shopping list and the game's own shortlist -----
  const profileIds = new Set<number>([
    ...transfers.targets.map((t2) => t2.playerId),
    ...(input.shortlist?.ids ?? []),
  ]);
  const scoutProfiles = [...profileIds]
    .map((pid) => {
      const row = players.get(pid);
      if (!row) return null;
      const teamId =
        rowsOf(tables, 'teamplayerlinks')
          .filter((l) => num(l, 'playerid') === pid)
          .map((l) => num(l, 'teamid'))
          .find((tid): tid is number => tid !== null && leagueIdOfTeam.has(tid)) ??
        clubOf.get(pid) ??
        null;
      const age = ageAt(num(row, 'birthdate'), gameDate.date);
      return {
        playerId: pid,
        name: nameOf(pid),
        nation: nationName(num(row, 'nationality')),
        age,
        positionShort: positionShort(num(row, 'preferredposition1')),
        preferredPositions: [1, 2, 3, 4]
          .map((n) => num(row, `preferredposition${n}`))
          .filter((v): v is number => v !== null && v >= 0)
          .map((c) => positionShort(c) ?? positionName(c)),
        overall: num(row, 'overallrating'),
        potential: num(row, 'potential'),
        foot: (num(row, 'preferredfoot') === 2 ? 'Left' : 'Right') as 'Left' | 'Right',
        height: num(row, 'height'),
        weight: num(row, 'weight'),
        skillMoves: num(row, 'skillmoves'),
        weakFoot: num(row, 'weakfootabilitytypecode'),
        groups: allGroupsFor(row).map((group) => {
          const attributes: AttributeValue[] = group.members.map((key) => ({
            name: key,
            value: num(row, key),
            seasonDelta: null,
          }));
          const present = attributes.filter((a) => a.value !== null);
          return {
            name: group.name,
            attributes,
            mean: present.length
              ? Math.round((present.reduce((sum, a) => sum + a.value!, 0) / present.length) * 10) / 10
              : null,
            seasonDelta: null,
          };
        }),
        playStyles: readPlayStyles(row),
        standout: standoutAttributes(worldStats, slotOf(num(row, 'preferredposition1')), row),
        teamName: teamNames.get(teamId ?? -1) ?? null,
        league: teamId !== null ? (leagueOfTeam.get(teamId) ?? null) : null,
        contractMonths: contractMonths(num(row, 'contractvaliduntil'), gameDate.date),
        wage: num(contracts.get(pid), 'wage'),
        ea: eaValue(num(row, 'overallrating'), age, num(row, 'potential'), num(row, 'preferredposition1')),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

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
    // 0 dollar, 1 euro, 2 pound — the standard FC enum, and the dev save's 2
    // matches an English club's pounds in game.
    currency: { 0: '$', 1: '€', 2: '£' }[num(pref, 'currency') ?? 2] ?? '£',
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
    opponents,
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
    leagueTable,
    treatment,
    calendar,
    coaching,
    finances,
    sellValues,
    shortlistIngame,
    academyReports,
    scoutProfiles,
    story:
      input.store && input.careerId !== undefined
        ? input.store.story(input.careerId).map((e) => ({
            key: e.key,
            kind: e.kind,
            season: e.season,
            title: e.title,
            detail: e.detail,
            gameDate: e.gameDate,
          }))
        : [],
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
