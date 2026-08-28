/**
 * Loans — who is out, who came in, and where a loan candidate should go.
 *
 * `playerloans` records every active loan in the world with the lending club and
 * the end date, so the tracker is read, not inferred. The one modelled part is
 * the destination list: for a player the rules say should go out (starved or
 * third choice), the clubs worth sending him to are the ones where his current
 * level makes him a starter — a club rated just below or at his overall, in a
 * real domestic league. A loan spent on a better team's bench defeats
 * the purpose, and that is a statement about club ratings the save carries.
 */
import type { Row } from '../parser/dbReader.ts';

const num = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;

export interface LoanRecord {
  playerId: number;
  name: string;
  /** The club he is playing at right now. */
  atTeamId: number | null;
  atTeamName: string | null;
  /** In-game date the loan ends, as yyyy-mm-dd, from the loan row itself. */
  ends: string | null;
  buyOption: boolean;
  overall: number | null;
  potential: number | null;
  age: number | null;
  /**
   * Change since the season began, from our own snapshots. The save keeps NO
   * match record for a player at his loan club (verified: zero
   * career_playermatchratinghistory rows for all four players currently out),
   * so observed growth is the only readable signal of whether a loan works.
   */
  overallDelta?: number | null;
  ceilingDelta?: number | null;
}

export interface LoanDestination {
  teamId: number;
  teamName: string;
  clubOverall: number;
  leagueName: string | null;
  /** Why this club: how his level sits against theirs. */
  read: string;
}

export interface LoanCandidate {
  playerId: number;
  reason: string;
  ruleId: string;
  overall: number | null;
  destinations: LoanDestination[];
  /** How to structure the deal when an approach comes in. */
  dealGuide: string[];
}

export interface LoansView {
  out: LoanRecord[];
  inbound: LoanRecord[];
  candidates: LoanCandidate[];
}

/** EA stores loan end dates as days since 1582-10-14, same epoch as birthdates. */
const EPOCH = Date.UTC(1582, 9, 14);
const dateFromDays = (days: number | null): string | null =>
  days === null || days <= 0
    ? null
    : new Date(EPOCH + days * 86_400_000).toISOString().slice(0, 10);

export interface LoansInput {
  loans: Row[];
  clubId: number | null;
  youthTeamId: number;
  clubOf: Map<number, number>;
  teamNames: Map<number, string>;
  teams: Row[];
  leagueOfTeam: Map<number, string>;
  eligibleClubs: Set<number>;
  playerById: Map<number, Row>;
  /** playerid -> the club holding his contract, from career_playercontract. */
  contractTeamOf: Map<number, number>;
  nameOf: (id: number) => string;
  ageOf: (player: Row) => number | null;
  /** Squad players whose advice says loan out, with the firing rule. */
  loanAdvised: { playerId: number; ruleId: string; line: string }[];
}

export function buildLoans(input: LoansInput): LoansView {
  const record = (playerId: number, loan: Row): LoanRecord => {
    const player = input.playerById.get(playerId);
    const atTeamId = input.clubOf.get(playerId) ?? null;
    return {
      playerId,
      name: input.nameOf(playerId),
      atTeamId,
      atTeamName: atTeamId === null ? null : (input.teamNames.get(atTeamId) ?? null),
      ends: dateFromDays(num(loan, 'loandateend')),
      buyOption: (num(loan, 'isloantobuy') ?? 0) !== 0,
      overall: num(player, 'overallrating'),
      potential: num(player, 'potential'),
      age: player ? input.ageOf(player) : null,
    };
  };

  const out: LoanRecord[] = [];
  const inbound: LoanRecord[] = [];

  for (const loan of input.loans) {
    const playerId = num(loan, 'playerid');
    const from = num(loan, 'teamidloanedfrom');
    if (playerId === null || from === null) continue;

    if (from === input.clubId || from === input.youthTeamId) {
      // The loan row alone is not proof of ownership: this save carries a stale
      // row for a player sold seasons ago (70458, no contract with us). Ours
      // means the contract says ours.
      const contractTeam = input.contractTeamOf.get(playerId);
      if (contractTeam === input.clubId || contractTeam === input.youthTeamId) {
        out.push(record(playerId, loan));
      }
    } else {
      // Inbound: with us but on someone else's paper. The save also holds
      // loan rows whose from-id maps to no team at all while the player is
      // contracted to us (six of them in this save, Rashford among them) — those
      // are not loans we can read, and a row we cannot read is dropped, not
      // rendered as "from null".
      const current = input.clubOf.get(playerId);
      const parentIsReal = input.teamNames.has(from);
      const parentHoldsContract = input.contractTeamOf.get(playerId) === from;
      if (
        (current === input.clubId || current === input.youthTeamId) &&
        parentIsReal &&
        parentHoldsContract
      ) {
        const rec = record(playerId, loan);
        rec.atTeamId = from;
        rec.atTeamName = input.teamNames.get(from) ?? null;
        inbound.push(rec);
      }
    }
  }
  out.sort((a, b) => (b.potential ?? 0) - (a.potential ?? 0));

  // Destination shortlist per loan-advised player: clubs rated OVR-4 .. OVR+1,
  // signable, not us — he walks into their XI rather than onto another bench.
  const candidates: LoanCandidate[] = [];
  for (const advised of input.loanAdvised) {
    const player = input.playerById.get(advised.playerId);
    const overall = num(player, 'overallrating');
    if (overall === null) continue;

    const destinations: LoanDestination[] = [];
    for (const team of input.teams) {
      const teamId = num(team, 'teamid');
      const clubOverall = num(team, 'overallrating');
      const teamName = team['teamname'];
      if (teamId === null || clubOverall === null || typeof teamName !== 'string') continue;
      if (teamId === input.clubId || teamId === input.youthTeamId) continue;
      if (!input.eligibleClubs.has(teamId)) continue;
      if (clubOverall < overall - 4 || clubOverall > overall + 1) continue;

      destinations.push({
        teamId,
        teamName,
        clubOverall,
        leagueName: input.leagueOfTeam.get(teamId) ?? null,
        read:
          clubOverall <= overall
            ? `above the club's ${clubOverall} level — starts every week`
            : `the club's ${clubOverall} is a step up, but a startable one`,
      });
    }
    // Prefer clubs a point or two below him: guaranteed football with a stretch.
    destinations.sort(
      (a, b) => Math.abs(a.clubOverall - (overall - 1)) - Math.abs(b.clubOverall - (overall - 1)),
    );

    const potential = num(player, 'potential');
    const growth = potential !== null ? potential - overall : null;
    const dealGuide: string[] = [];
    if (growth !== null && growth >= 8) {
      dealGuide.push('Refuse any buy option — ' + growth + ' still to grow, and a fixed price today sells that growth to someone else.');
      dealGuide.push('Full season, and prefer the club nearest their level so the minutes actually happen.');
    } else if (growth !== null && growth >= 3) {
      dealGuide.push('A buy option is acceptable only well above what you would sell for today.');
    } else {
      dealGuide.push('Take a buy option — at the ceiling already, a loan that becomes a sale is the best outcome.');
    }
    dealGuide.push('Ask for full wage cover; the wage is on your book either way.');

    candidates.push({
      playerId: advised.playerId,
      reason: advised.line,
      ruleId: advised.ruleId,
      overall,
      destinations: destinations.slice(0, 5),
      dealGuide,
    });
  }

  return { out, inbound, candidates };
}
