/**
 * Newgen tracking and retirements.
 *
 * ## On "regens"
 *
 * In older FIFA a retiring great was reissued into the youth pool carrying his
 * own name, so "this is a regen of Del Piero" was a real, checkable statement.
 * **FC 26 records no such link.** A sweep of all 52 tables finds no `regen`,
 * `origin`, `basedon`, `template`, `parent` or equivalent field; a newgen carries
 * an ordinary `firstnameid`/`lastnameid` from the same pool everyone else uses, a
 * nationality, a birth date, and a previous team of the youth pool. There is
 * nothing in the file tying him to anybody who retired.
 *
 * So this view does not claim a lineage, because claiming one would mean
 * inventing it. What it does instead is the useful half of the same job: track
 * every newgen at the club from the moment he appears, keep him visible after he
 * leaves the academy, and list the players the save has actually flagged as
 * retiring — which is the pool the game is drawing down as it generates new ones.
 *
 * Detection is structural: a player whose id sits above the base game's range did
 * not ship with the game. On this save the base roster tops out well below
 * 400000 and every newgen sits above 459000.
 */
import type { Row } from '../parser/dbReader.ts';
import type { HistoryStore } from '../store/store.ts';
import type { PlayerTag } from '../store/tags.ts';

const numberOf = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;

/**
 * Ids at or above this did not ship with the game. Base rosters run to roughly
 * 300k with room to spare; newgens on this save begin at 459968.
 */
export const NEWGEN_ID_FLOOR = 400_000;

export const isNewgen = (playerId: number): boolean => playerId >= NEWGEN_ID_FLOOR;

export type RegenLocation = 'academy' | 'senior' | 'on-loan' | 'elsewhere' | 'gone';

export interface RegenRecord {
  playerId: number;
  name: string;
  age: number | null;
  overall: number | null;
  potential: number | null;
  headroom: number | null;
  location: RegenLocation;
  teamId: number | null;
  teamName: string | null;
  /** Overall the first time we ever saw him, and when. */
  firstSeen: { overall: number | null; gameDate: number | null; snapshotId: number } | null;
  /** Change in overall since we first saw him. */
  overallSinceFirstSeen: number | null;
  snapshotsSeen: number;
  tags: PlayerTag[];
  /** True when he is in our history but not in the current save at all. */
  lostFromSave: boolean;
}

export interface RetiringPlayer {
  playerId: number;
  name: string;
  age: number | null;
  overall: number | null;
  teamName: string | null;
  ourPlayer: boolean;
}

export interface RegenReport {
  tracked: RegenRecord[];
  /** Newgens in the world we have never recorded — the intake radar. */
  inWorld: number;
  atOurClub: number;
  watched: number;
  /**
   * Players the save has flagged `isretiring`. Not linked to any newgen — see the
   * note at the top of this file — but this is the pool going out of the game.
   */
  retiring: RetiringPlayer[];
  retiringTotal: number;
  /** Stated on screen so the absence is explicit, not silently worked around. */
  lineageAvailable: false;
}

export interface RegenInput {
  players: Map<number, Row>;
  /** playerid -> the link row for whichever squad he is in. */
  links: Map<number, Row>;
  teamNames: Map<number, string>;
  ourClubId: number | null;
  youthTeamId: number;
  loanedIds: Set<number>;
  gameDate: number | null;
  nameOf: (id: number) => string;
  ageOf: (player: Row) => number | null;
  tags: Map<number, PlayerTag[]>;
  store?: HistoryStore | undefined;
  careerId?: number | undefined;
}

function locate(input: RegenInput, playerId: number): { location: RegenLocation; teamId: number | null } {
  const link = input.links.get(playerId);
  const teamId = numberOf(link, 'teamid');

  if (teamId === null) return { location: 'gone', teamId: null };
  if (teamId === input.youthTeamId) return { location: 'academy', teamId };
  if (teamId === input.ourClubId) {
    return { location: input.loanedIds.has(playerId) ? 'on-loan' : 'senior', teamId };
  }
  return { location: 'elsewhere', teamId };
}

/**
 * Build the tracker.
 *
 * Three groups are included, and nothing else: newgens at our club, newgens in
 * our academy, and any player the user has tagged — because a tag is a request to
 * keep watching, wherever he ends up.
 */
export function buildRegenReport(input: RegenInput): RegenReport {
  const interesting = new Set<number>();
  let inWorld = 0;
  let atOurClub = 0;

  for (const [playerId] of input.players) {
    if (!isNewgen(playerId)) continue;
    inWorld++;
    const { location } = locate(input, playerId);
    if (location === 'academy' || location === 'senior' || location === 'on-loan') {
      interesting.add(playerId);
      atOurClub++;
    }
  }

  // A tag says "keep watching this one", so it wins over location.
  for (const playerId of input.tags.keys()) interesting.add(playerId);

  const tracked: RegenRecord[] = [];

  for (const playerId of interesting) {
    const player = input.players.get(playerId);
    const tags = input.tags.get(playerId) ?? [];

    if (!player) {
      // Tagged but no longer in the save at all — the case this view exists for.
      tracked.push({
        playerId,
        name: input.nameOf(playerId),
        age: null,
        overall: null,
        potential: null,
        headroom: null,
        location: 'gone',
        teamId: null,
        teamName: null,
        firstSeen: null,
        overallSinceFirstSeen: null,
        snapshotsSeen: 0,
        tags,
        lostFromSave: true,
      });
      continue;
    }

    const overall = numberOf(player, 'overallrating');
    const potential = numberOf(player, 'potential');
    const { location, teamId } = locate(input, playerId);

    let firstSeen: RegenRecord['firstSeen'] = null;
    let snapshotsSeen = 0;
    if (input.store && input.careerId !== undefined) {
      const series = input.store.series(input.careerId, playerId, 'overallrating');
      snapshotsSeen = series.length;
      const first = series[0];
      if (first) {
        firstSeen = { overall: first.value, gameDate: first.gameDate, snapshotId: first.snapshotId };
      }
    }

    tracked.push({
      playerId,
      name: input.nameOf(playerId),
      age: input.ageOf(player),
      overall,
      potential,
      headroom: overall !== null && potential !== null ? potential - overall : null,
      location,
      teamId,
      teamName: teamId === null ? null : (input.teamNames.get(teamId) ?? null),
      firstSeen,
      overallSinceFirstSeen:
        overall !== null && firstSeen?.overall != null ? overall - firstSeen.overall : null,
      snapshotsSeen,
      tags,
      lostFromSave: false,
    });
  }

  tracked.sort(
    (a, b) =>
      Number(b.tags.length > 0) - Number(a.tags.length > 0) ||
      (b.potential ?? 0) - (a.potential ?? 0) ||
      (b.overall ?? 0) - (a.overall ?? 0),
  );

  // Who the save says is on the way out. Deliberately not joined to anything
  // above: FC 26 records no link between a retirement and a newgen.
  const retiring: RetiringPlayer[] = [];
  for (const [playerId, player] of input.players) {
    if ((numberOf(player, 'isretiring') ?? 0) === 0) continue;
    const teamId = numberOf(input.links.get(playerId), 'teamid');
    retiring.push({
      playerId,
      name: input.nameOf(playerId),
      age: input.ageOf(player),
      overall: numberOf(player, 'overallrating'),
      teamName: teamId === null ? null : (input.teamNames.get(teamId) ?? null),
      ourPlayer: teamId === input.ourClubId || teamId === input.youthTeamId,
    });
  }
  retiring.sort(
    (a, b) => Number(b.ourPlayer) - Number(a.ourPlayer) || (b.overall ?? 0) - (a.overall ?? 0),
  );

  return {
    tracked,
    inWorld,
    atOurClub,
    watched: input.tags.size,
    retiring: retiring.slice(0, 60),
    retiringTotal: retiring.length,
    lineageAvailable: false,
  };
}
