/**
 * The story ledger: turning a save into the things that happened.
 *
 * Everything else in Companion answers "what is true now". This answers "what
 * changed, and when did we first see it" — which is a different question and
 * needs a different discipline. Each event carries a stable `key`; the store
 * writes it once and never again, so the date on an event is the date it
 * entered the save, not the date some later parse noticed it.
 *
 * The rules for what earns a line:
 *
 *  - it must be **derivable from the save**, never from a client preference
 *    (RPG campaign choice lives in the browser, so no campaign milestones here);
 *  - it must be **an event, not a state** — "won the FA Cup" happened, "is
 *    third in the league" is just today;
 *  - it must be **worth remembering in a year**, or it is noise.
 *
 * Player-rating milestones are deliberately coarse (crossing 80/85/90) because
 * a save is written many times a week and a ledger of every +1 is a log, not a
 * story.
 */
import type { Row, Tables } from '../parser/dbReader.ts';
import type { StoryEventInput } from '../store/store.ts';

const num = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;
const rowsOf = (t: Tables, name: string): Row[] => t[name] ?? [];

export interface StoryInput {
  tables: Tables;
  careerId: number;
  snapshotId: number;
  gameDate: number | null;
  season: number | null;
  /** Resolves a player id to a display name. */
  nameOf: (id: number) => string;
  /** Resolves a team id to a club name. */
  teamNameOf: (id: number) => string | null;
  /** Competition short code to a readable name, from data/competitions.csv. */
  competitionOf: (code: string) => string | null;
  /** Ids currently in the senior squad, for promotion detection. */
  seniorIds: Set<number>;
  /** Ids currently in the academy. */
  academyIds: Set<number>;
  /** Overall for a player id, at this snapshot. */
  overallOf: (id: number) => number | null;
  /** Player ids that were in the academy at the previous snapshot, if known. */
  previousAcademyIds?: Set<number> | undefined;
  /** Highest overall previously recorded per player, for milestone crossings. */
  previousOverall?: Map<number, number> | undefined;
}

/** Rating thresholds worth a line in the book. */
const MILESTONES = [80, 85, 90] as const;

/**
 * Which season a date belongs to. Seasons run July to June, and the current
 * season plus the current date pin the whole scale — so a record set two years
 * ago files itself under the season it was set in rather than under today.
 */
export function seasonOfDate(ymd: number | null, gameDate: number | null, season: number | null): number | null {
  if (ymd === null || gameDate === null || season === null) return null;
  const seasonYear = (d: number): number => {
    const y = Math.floor(d / 10000);
    const m = Math.floor((d % 10000) / 100);
    return m >= 7 ? y : y - 1;
  };
  return season - (seasonYear(gameDate) - seasonYear(ymd));
}

export function deriveStoryEvents(input: StoryInput): StoryEventInput[] {
  const { tables, careerId, snapshotId, gameDate, season } = input;
  const out: StoryEventInput[] = [];
  const add = (
    key: string,
    kind: string,
    title: string,
    detail: string | null,
    eventSeason: number | null,
    date: number | null = gameDate,
  ): void => {
    out.push({ careerId, key, kind, season: eventSeason, title, detail, gameDate: date, snapshotId });
  };

  // --- trophies -------------------------------------------------------------
  // `hasteamwon` on a competition-progress row is a completed fact with a
  // season attached, so it keys cleanly and never moves again.
  for (const r of rowsOf(tables, 'career_competitionprogress')) {
    if ((num(r, 'hasteamwon') ?? 0) === 0) continue;
    const sn = num(r, 'season');
    const code = typeof r['compshortname'] === 'string' ? r['compshortname'] : '';
    const objId = num(r, 'compobjid');
    // Only compobjid 808 recurs every season as the league campaign; any other
    // blank code is a competition the community map does not name yet, and it
    // says so with the app's derived marker rather than borrowing a name.
    const name = code
      ? (input.competitionOf(code) ?? code)
      : objId === 808
        ? 'the league'
        : `an unnamed competition (#${objId})~`;
    add(`trophy:${sn}:${code || objId}`, 'trophy', `Won ${name}`, null, sn);
  }

  // --- seasons completed ----------------------------------------------------
  for (const r of rowsOf(tables, 'career_managerhistory')) {
    const sn = num(r, 'season');
    const pos = num(r, 'tableposition');
    if (sn === null || pos === null || pos <= 0) continue;
    const w = num(r, 'wins') ?? 0;
    const d = num(r, 'draws') ?? 0;
    const l = num(r, 'losses') ?? 0;
    const pts = num(r, 'points');
    add(
      `season:${sn}`,
      'season',
      pos === 1 ? `Champions in season ${sn}` : `Finished ${pos}${ordinalSuffix(pos)} in season ${sn}`,
      `${w}W ${d}D ${l}L${pts === null ? '' : ` · ${pts} points`}`,
      sn,
    );

    // Transfer business is recorded per season by the game itself.
    const buy = r['bigbuyplayername'];
    const buyAmt = num(r, 'bigbuyamount');
    if (typeof buy === 'string' && buy && buyAmt) {
      add(`buy:${sn}`, 'signing', `Signed ${buy}`, `Season ${sn}'s biggest arrival`, sn);
    }
    const sell = r['bigsellplayername'];
    const sellAmt = num(r, 'bigsellamount');
    if (typeof sell === 'string' && sell && sellAmt) {
      add(`sell:${sn}`, 'sale', `Sold ${sell}`, `Season ${sn}'s biggest departure`, sn);
    }
  }

  // --- record scorelines ----------------------------------------------------
  const mi = rowsOf(tables, 'career_managerinfo')[0];
  for (const kind of ['win', 'loss'] as const) {
    const us = num(mi, `big${kind}userscore`);
    const them = num(mi, `big${kind}oppscore`);
    const date = num(mi, `big${kind}date`);
    const opp = num(mi, `big${kind}oppteamid`);
    if (us === null || them === null || date === null || date <= 20080101) continue;
    if (kind === 'win' && us === 0 && them === 0) continue;
    const oppName = opp === null ? 'unknown' : (input.teamNameOf(opp) ?? `team ${opp}`);
    add(
      `record:${kind}:${date}:${us}-${them}`,
      kind === 'win' ? 'record-win' : 'record-loss',
      kind === 'win' ? `Beat ${oppName} ${us}–${them}` : `Lost ${us}–${them} to ${oppName}`,
      kind === 'win' ? 'A club record win' : 'A club record defeat',
      seasonOfDate(date, gameDate, season),
      date,
    );
  }

  // --- academy promotions ---------------------------------------------------
  // Someone who was in the academy last time we looked and is in the senior
  // squad now was promoted. Without a previous snapshot we say nothing rather
  // than guessing from months-in-squad.
  if (input.previousAcademyIds) {
    for (const id of input.previousAcademyIds) {
      if (!input.seniorIds.has(id)) continue;
      add(
        `promotion:${id}`,
        'promotion',
        `${input.nameOf(id)} promoted to the first team`,
        'Out of the academy',
        season,
      );
    }
  }

  // --- rating milestones ----------------------------------------------------
  if (input.previousOverall) {
    for (const id of [...input.seniorIds, ...input.academyIds]) {
      const now = input.overallOf(id);
      const before = input.previousOverall.get(id);
      if (now === null || before === undefined) continue;
      for (const mark of MILESTONES) {
        if (before < mark && now >= mark) {
          add(
            `rating:${id}:${mark}`,
            'milestone',
            `${input.nameOf(id)} reached ${mark}`,
            `Up from ${before}`,
            season,
          );
        }
      }
    }
  }

  return out;
}

const ordinalSuffix = (n: number): string =>
  n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
