/**
 * Wage guidance (spec.md §3.7, "Wage packages").
 *
 * The save carries what every player at the club actually earns, his squad role,
 * his age and his headroom. That is enough to answer a real question — *is this
 * player paid like his peers?* — without inventing a market.
 *
 * What this deliberately does not do: predict what a player would accept, price a
 * transfer, or apply a multiplier pulled out of the air. The FC 26 companion's
 * `×1.2` for a renewal was exactly that. Here the reference point is always the
 * squad's own distribution, which is a fact.
 *
 * `career_managerpref.transferbudget` and `.wagebudget` both read 0 in this save,
 * so budget headroom is reported as unknown rather than as zero.
 */
import type { Row } from '../parser/dbReader.ts';

const num = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;

export interface WageBand {
  role: string;
  count: number;
  median: number;
  low: number;
  high: number;
}

export type WageVerdict = 'under' | 'in-line' | 'over' | 'unknown';

export interface WageAssessment {
  playerId: number;
  wage: number | null;
  /** Share of the club's total wage bill. */
  shareOfBill: number | null;
  /** Median wage of squad members in the same role band. */
  peerMedian: number | null;
  peerCount: number;
  verdict: WageVerdict;
  note: string;
}

/**
 * A renewal proposal.
 *
 * Two shapes, because they are genuinely different bets. A flat deal is
 * predictable and costs the same whether he plays or not. A bonus-loaded deal
 * pays less up front and more when he delivers, which suits a player you are not
 * yet sure about — and the save shows FC 26 stores exactly that structure:
 * `career_playercontract` carries `performancebonustype`, `performancebonusvalue`
 * and `performancebonuscount` alongside the wage.
 *
 * Every figure is anchored to the squad's own role bands and the player's own
 * current wage. Nothing here predicts what he would accept — the save does not
 * record a demand, and inventing one would be the wrong kind of confident.
 */
export interface RenewalOption {
  kind: 'flat' | 'performance';
  label: string;
  years: number;
  weeklyWage: number;
  signOnBonus: number | null;
  /** Bonus per appearance/goal band, when the option uses one. */
  bonusPerEvent: number | null;
  bonusEvents: number | null;
  /** Guaranteed cost over the term. */
  guaranteedCost: number;
  /** Cost if every bonus is triggered. */
  maximumCost: number;
  why: string;
  tradeoff: string;
}

export interface ReleaseClauseAdvice {
  recommend: boolean;
  amount: number | null;
  why: string;
}

export interface RenewalProposal {
  playerId: number;
  currentWage: number | null;
  monthsLeft: number | null;
  urgency: 'now' | 'soon' | 'later';
  options: RenewalOption[];
  releaseClause: ReleaseClauseAdvice;
}

export interface WageReport {
  totalBill: number;
  squadSize: number;
  median: number | null;
  bands: WageBand[];
  assessments: Map<number, WageAssessment>;
  /** Contracts inside 12 months, most urgent first. */
  expiring: { playerId: number; monthsLeft: number; wage: number | null }[];
  /** Renewal proposals for anyone worth renewing. */
  renewals: RenewalProposal[];
  budgetKnown: false;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
};

/**
 * Peers are players in the same role band, because a rotation player earning the
 * squad median is not the same as a crucial one earning it.
 */
const ROLE_BANDS: Record<number, string> = {
  [-1]: 'Unassigned',
  0: 'Reserve',
  1: 'Crucial',
  2: 'Important',
  3: 'Rotation',
  4: 'Sporadic',
  5: 'Prospect',
};

export interface WageInput {
  playerId: number;
  wage: number | null;
  roleCode: number | null;
  age: number | null;
  headroom: number | null;
  contractMonths: number | null;
}

export function buildWageReport(players: WageInput[]): WageReport {
  const paid = players.filter((p) => p.wage !== null && p.wage > 0);
  const totalBill = paid.reduce((sum, p) => sum + p.wage!, 0);

  const byBand = new Map<string, number[]>();
  for (const player of paid) {
    const band = ROLE_BANDS[player.roleCode ?? -1] ?? 'Unassigned';
    const list = byBand.get(band) ?? [];
    list.push(player.wage!);
    byBand.set(band, list);
  }

  const bands: WageBand[] = [...byBand.entries()]
    .map(([role, wages]) => ({
      role,
      count: wages.length,
      median: median(wages)!,
      low: Math.min(...wages),
      high: Math.max(...wages),
    }))
    .sort((a, b) => b.median - a.median);

  const assessments = new Map<number, WageAssessment>();
  for (const player of players) {
    const band = ROLE_BANDS[player.roleCode ?? -1] ?? 'Unassigned';
    // The band median includes this player. Excluding him by value would also
    // drop anyone else on the same wage, and would swing the median wildly in a
    // small band — which is most bands in a 24-man squad.
    const bandWages = byBand.get(band) ?? [];
    const peerMedian = median(bandWages);
    const peers = bandWages.length - 1;

    let verdict: WageVerdict = 'unknown';
    let note = 'No wage recorded for this player.';

    if (player.wage !== null && peerMedian !== null && peers >= 2) {
      const ratio = player.wage / peerMedian;
      if (ratio < 0.7) {
        verdict = 'under';
        note =
          player.headroom !== null && player.headroom >= 3
            ? `Paid well below ${band.toLowerCase()} peers while still improving — a cheap renewal now costs less than one later.`
            : `Paid well below ${band.toLowerCase()} peers.`;
      } else if (ratio > 1.4) {
        verdict = 'over';
        note =
          player.headroom !== null && player.headroom <= 1 && (player.age ?? 0) >= 30
            ? `Paid well above ${band.toLowerCase()} peers with no growth left at ${player.age}.`
            : `Paid well above ${band.toLowerCase()} peers.`;
      } else {
        verdict = 'in-line';
        note = `In line with ${band.toLowerCase()} peers.`;
      }
    } else if (player.wage !== null) {
      verdict = 'unknown';
      note = `Too few ${band.toLowerCase()} peers in the squad to compare against.`;
    }

    assessments.set(player.playerId, {
      playerId: player.playerId,
      wage: player.wage,
      shareOfBill: player.wage !== null && totalBill > 0 ? player.wage / totalBill : null,
      peerMedian,
      peerCount: peers,
      verdict,
      note,
    });
  }

  const expiring = players
    .filter((p) => p.contractMonths !== null && p.contractMonths <= 12)
    .map((p) => ({ playerId: p.playerId, monthsLeft: p.contractMonths!, wage: p.wage }))
    .sort((a, b) => a.monthsLeft - b.monthsLeft);

  const renewals = players
    .filter((p) => shouldPropose(p))
    .map((p) => proposeRenewal(p, assessments.get(p.playerId)?.peerMedian ?? null))
    .filter((r): r is RenewalProposal => r !== null)
    .sort((a, b) => (a.monthsLeft ?? 999) - (b.monthsLeft ?? 999));

  return {
    totalBill,
    squadSize: paid.length,
    median: median(paid.map((p) => p.wage!)),
    bands,
    assessments,
    expiring,
    renewals,
    budgetKnown: false,
  };
}

/** Worth proposing for: a deal running down, or someone paid below his band. */
function shouldPropose(p: WageInput): boolean {
  if (p.wage === null || p.wage <= 0) return false;
  const running = p.contractMonths !== null && p.contractMonths <= 24;
  const improving = (p.headroom ?? 0) >= 3;
  return running || improving;
}

const round = (n: number, to: number): number => Math.max(to, Math.round(n / to) * to);

/**
 * Build the two options.
 *
 * Term length follows age and headroom, because those are the two things that
 * decide how long the club wants him: a 19-year-old with room to grow is worth
 * locking down, a 33-year-old at his ceiling is worth one more year.
 */
export function proposeRenewal(p: WageInput, bandMedian: number | null): RenewalProposal | null {
  const wage = p.wage;
  if (wage === null || wage <= 0) return null;

  const age = p.age ?? 26;
  const headroom = p.headroom ?? 0;
  const months = p.contractMonths;

  const years = age <= 21 && headroom >= 6 ? 5 : age <= 25 ? 4 : age <= 29 ? 3 : age <= 32 ? 2 : 1;

  // The anchor is the band's median, or the player's own wage when the band is too thin
  // to say anything. Growth still to come argues for more; no growth left argues
  // for holding station.
  const anchor = bandMedian ?? wage;
  const growthUplift = headroom >= 8 ? 0.35 : headroom >= 4 ? 0.2 : headroom >= 1 ? 0.1 : 0;
  const towardBand = anchor > wage ? Math.min(0.3, (anchor - wage) / wage) : 0;

  const flatWage = round(wage * (1 + growthUplift + towardBand), 500);
  // The performance option trades guaranteed money for triggered money.
  const baseWage = round(flatWage * 0.82, 500);
  const bonusEvents = 20;
  const bonusPerEvent = round(((flatWage - baseWage) * 52) / bonusEvents, 1000);
  const signOn = round(flatWage * (years >= 4 ? 4 : 2), 5000);

  const weeks = years * 52;
  const options: RenewalOption[] = [
    {
      kind: 'flat',
      label: `${years} years, flat`,
      years,
      weeklyWage: flatWage,
      signOnBonus: signOn,
      bonusPerEvent: null,
      bonusEvents: null,
      guaranteedCost: flatWage * weeks + signOn,
      maximumCost: flatWage * weeks + signOn,
      why:
        towardBand > 0
          ? `Brings the wage up toward the ${Math.round(anchor).toLocaleString('en-GB')} median for the role band.`
          : 'Holds the wage roughly where it is, adjusted for the growth still to come.',
      tradeoff: 'Predictable. You pay it match or no match.',
    },
    {
      kind: 'performance',
      label: `${years} years, base plus appearance bonus`,
      years,
      weeklyWage: baseWage,
      signOnBonus: round(signOn * 0.6, 5000),
      bonusPerEvent,
      bonusEvents,
      guaranteedCost: baseWage * weeks + round(signOn * 0.6, 5000),
      maximumCost: baseWage * weeks + round(signOn * 0.6, 5000) + bonusPerEvent * bonusEvents * years,
      why: `${Math.round((1 - baseWage / flatWage) * 100)}% less guaranteed, with ${bonusPerEvent.toLocaleString('en-GB')} per appearance after ${bonusEvents} in a season.`,
      tradeoff:
        headroom >= 6
          ? 'Cheaper without a breakthrough — and at this age the breakthrough is not guaranteed.'
          : 'Cheaper on the bench, dearer than the flat deal for an every-week starter.',
    },
  ];

  const releaseClause: ReleaseClauseAdvice =
    headroom >= 6 && age <= 23
      ? {
          recommend: false,
          amount: null,
          why:
            'No clause. ' + headroom + ' of growth left; a number set today prices the player at ' +
            'today\u2019s level, and a buyer will pay it exactly when that level is beaten.',
        }
      : age >= 30 || headroom <= 1
        ? {
            recommend: true,
            amount: round(flatWage * 52 * 2.5, 100000),
            why:
              'A clause is fine here. Little appreciation is left, so a fixed exit at roughly ' +
              'two and a half years of wages turns the contract into money rather than a stranded deal.',
          }
        : {
            recommend: false,
            amount: null,
            why: 'Leave it out while the player is still improving — negotiate a fee when someone asks.',
          };

  return {
    playerId: p.playerId,
    currentWage: wage,
    monthsLeft: months,
    urgency: months === null ? 'later' : months <= 6 ? 'now' : months <= 18 ? 'soon' : 'later',
    options,
    releaseClause,
  };
}

/** Contract months from `contractvaliduntil` (a year) and the in-game date. */
export function contractMonths(validUntilYear: number | null, gameDate: number | null): number | null {
  if (validUntilYear === null || gameDate === null) return null;
  if (validUntilYear < 2000 || validUntilYear > 2100) return null;

  const year = Math.floor(gameDate / 10000);
  const month = Math.floor((gameDate % 10000) / 100);
  // Contracts in FC expire on 30 June of the stated year.
  return (validUntilYear - year) * 12 + (6 - month);
}

export const wageInputFrom = (
  playerId: number,
  player: Row | undefined,
  contract: Row | undefined,
  gameDate: number | null,
  headroom: number | null,
  age: number | null,
): WageInput => ({
  playerId,
  wage: num(contract, 'wage'),
  roleCode: num(contract, 'playerrole'),
  age,
  headroom,
  contractMonths: contractMonths(num(player, 'contractvaliduntil'), gameDate),
});
