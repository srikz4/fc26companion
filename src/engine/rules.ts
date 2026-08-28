/**
 * The recommendation router (spec.md §5.3).
 *
 * Every player gets exactly one advice line, from the highest-priority rule that
 * fires. Lower firings stay available for the alert rail and the player panel.
 * R-99 always fires, so nobody is ever silent.
 *
 * Three constraints hold throughout:
 *
 *  - **A rule may only read confirmed inputs.** If a field is unknown the rule
 *    does not fire; it never fires on a default.
 *  - **Every line carries its evidence**, so "sell next window" arrives with the
 *    numbers that produced it rather than as an opinion.
 *  - **Thresholds live here**, in one file, and nowhere else.
 *
 * R-01 and R-09 (ceiling drift) were gated on A-3 — potential had to be seen
 * moving within one career. It has been: 2026-08-28, a senior player's
 * potential rose 84 -> 85 across this career's own snapshots. The gate is open.
 */

export const THRESHOLDS = {
  youngAge: 21,
  prospectAge: 22,
  academyAge: 19,
  veteranAge: 30,
  releaseAge: 32,
  starvedMinutesPct: 25,
  heavyMinutesPct: 70,
  starvedHeadroom: 8,
  atCeilingHeadroom: 1,
  renewHeadroom: 3,
  contractMonthsWarning: 15,
  contractMonthsUrgent: 6,
  /** An academy deal inside this many months is worth acting on now. */
  youthContractWarning: 24,
  youthContractUrgent: 12,
  /** Below this ceiling an expiring academy deal is not worth interrupting for. */
  youthWorthKeeping: 80,
  ceilingDropSeason: -2,
  ceilingRiseSeason: 2,
  repositionGain: 3,
  academyPotential: 85,
  blockedGapSeasons: 3,
  selectionFitCost: 3,
} as const;

/** A-3 passed 2026-08-28: potential observed moving within one career. */
export const ceilingDriftEnabled = true;

export type RuleId =
  | 'R-01' | 'R-03' | 'R-04' | 'R-05' | 'R-06' | 'R-07'
  | 'R-09' | 'R-10' | 'R-11' | 'R-12' | 'R-13' | 'R-14' | 'R-15' | 'R-99';

export type Severity = 'urgent' | 'action' | 'watch' | 'steady';

export interface Advice {
  rule: RuleId;
  priority: number;
  severity: Severity;
  /**
   * The action, in one or two words, as it appears on the card.
   *
   * Cards carry a badge, not a paragraph. "Loan out" is something you can act on
   * at a glance while a match is loading; "8 of headroom and barely playing,
   * give him minutes or loan him" is a sentence you have to stop and read.
   * The sentence still exists as `line` and shows on hover.
   */
  tag: string;
  /** The full sentence. Shown on demand, not on the face of the card. */
  line: string;
  /** The numbers behind it. */
  evidence: string;
}

/** Everything a rule is allowed to read. Nulls mean unknown, never zero. */
export interface RuleInput {
  playerId: number;
  name: string;
  age: number | null;
  overall: number | null;
  potential: number | null;
  headroom: number | null;
  minutesPct: number | null;
  overallSeasonDelta: number | null;
  ceilingDriftSeason: number | null;
  contractMonths: number | null;
  squad: 'senior' | 'academy';
  /** Best alternative slot and how much fit it would gain. */
  reposition: { from: string; to: string; gain: number } | null;
  /** A better long-term player is stuck behind this one. */
  blocking: { blockedName: string; blockedPotential: number; seasons: number } | null;
  /** This player is the one stuck. */
  blockedBy: { name: string; seasons: number } | null;
  depthRank: number | null;
  depthRankTwoPotential: number | null;
  injured: boolean;
  retiring: boolean;
  /** Saved XI differs from the recommended XI at this player's slot. */
  selectionCost: { slot: string; instead: string; fitCost: number } | null;
}

const pct = (v: number | null): string => (v === null ? 'unknown' : `${Math.round(v)}%`);

/** Contract time the way the game says it: "3y 6m", "2y", "8m". */
export const term = (months: number | null): string =>
  months === null
    ? 'unknown'
    : months < 12
      ? `${months}m`
      : `${Math.floor(months / 12)}y${months % 12 ? ` ${months % 12}m` : ''}`;

type Rule = (i: RuleInput) => Advice | null;

const RULES: Rule[] = [
  // R-01 ceiling loss — gated on A-3.
  (i) =>
    ceilingDriftEnabled &&
    i.ceilingDriftSeason !== null &&
    i.ceilingDriftSeason <= THRESHOLDS.ceilingDropSeason &&
    i.age !== null &&
    i.age <= THRESHOLDS.youngAge
      ? {
          rule: 'R-01',
          priority: 100,
          severity: 'urgent',
          tag: 'Ceiling falling',
          line: `Ceiling has fallen ${Math.abs(i.ceilingDriftSeason)} this season. Act now.`,
          evidence: `potential ${i.ceilingDriftSeason} this season, age ${i.age}`,
        }
      : null,

  // R-03 starved prospect.
  (i) =>
    i.minutesPct !== null &&
    i.minutesPct < THRESHOLDS.starvedMinutesPct &&
    i.age !== null &&
    i.age <= THRESHOLDS.youngAge &&
    i.headroom !== null &&
    i.headroom >= THRESHOLDS.starvedHeadroom
      ? {
          rule: 'R-03',
          priority: 90,
          severity: 'action',
          tag: 'Loan out',
          line: `${i.headroom} of growth left and barely playing. Give them minutes or arrange a loan.`,
          evidence: `${pct(i.minutesPct)} of available minutes, age ${i.age}, growth left ${i.headroom}`,
        }
      : null,

  // R-04 blocked pathway.
  (i) =>
    i.blockedBy !== null && i.age !== null && i.age <= THRESHOLDS.prospectAge
      ? {
          rule: 'R-04',
          priority: 85,
          severity: 'action',
          tag: 'Blocked',
          line: `Stuck behind ${i.blockedBy.name} for the next ${i.blockedBy.seasons} seasons.`,
          evidence: `incumbent is at their ceiling and ${i.blockedBy.seasons} seasons from decline`,
        }
      : null,

  // R-05 declining veteran.
  (i) =>
    i.overallSeasonDelta !== null &&
    i.overallSeasonDelta < 0 &&
    i.age !== null &&
    i.age >= THRESHOLDS.veteranAge
      ? {
          rule: 'R-05',
          priority: 80,
          severity: 'action',
          tag: 'Sell',
          line: `Declining at ${i.age}. Sell in the next window while there is value.`,
          evidence: `overall ${i.overallSeasonDelta} this season, age ${i.age}`,
        }
      : null,

  // R-06 at ceiling and playing every week.
  (i) =>
    i.headroom !== null &&
    i.headroom <= THRESHOLDS.atCeilingHeadroom &&
    i.age !== null &&
    i.age >= THRESHOLDS.veteranAge &&
    i.minutesPct !== null &&
    i.minutesPct > THRESHOLDS.heavyMinutesPct
      ? {
          rule: 'R-06',
          priority: 75,
          severity: 'watch',
          tag: 'Rotate',
          line: `At their ceiling and playing ${pct(i.minutesPct)}. Those minutes could develop someone.`,
          evidence: `growth left ${i.headroom}, age ${i.age}, ${pct(i.minutesPct)} of minutes`,
        }
      : null,

  // R-07 release at expiry.
  (i) =>
    i.contractMonths !== null &&
    i.contractMonths <= THRESHOLDS.contractMonthsWarning &&
    i.headroom !== null &&
    i.headroom <= THRESHOLDS.atCeilingHeadroom &&
    i.age !== null &&
    i.age >= THRESHOLDS.releaseAge
      ? {
          rule: 'R-07',
          priority: 70,
          severity: 'watch',
          tag: 'Release',
          line: `Contract ends in ${term(i.contractMonths)} at ${i.age} with no growth left. Let it run out.`,
          evidence: `${term(i.contractMonths)} left, growth left ${i.headroom}, age ${i.age}`,
        }
      : null,

  // R-09 rising ceiling — gated on A-3.
  (i) =>
    ceilingDriftEnabled &&
    i.ceilingDriftSeason !== null &&
    i.ceilingDriftSeason >= THRESHOLDS.ceilingRiseSeason
      ? {
          rule: 'R-09',
          priority: 60,
          severity: 'watch',
          tag: 'Rising',
          line: `Ceiling up ${i.ceilingDriftSeason} this season. Keep doing what you are doing.`,
          evidence: `potential +${i.ceilingDriftSeason} this season`,
        }
      : null,

  // R-10 reposition.
  (i) =>
    i.reposition !== null && i.reposition.gain >= THRESHOLDS.repositionGain
      ? {
          rule: 'R-10',
          priority: 55,
          severity: 'watch',
          tag: 'Reposition',
          line: `Fits ${i.reposition.to} ${i.reposition.gain} better than ${i.reposition.from}.`,
          evidence: `computed fit, not the game's rating — see the calibration note`,
        }
      : null,

  // R-11 loan out.
  (i) =>
    i.age !== null &&
    i.age <= THRESHOLDS.prospectAge &&
    i.depthRank !== null &&
    i.depthRank >= 3 &&
    i.potential !== null &&
    i.depthRankTwoPotential !== null &&
    i.potential < i.depthRankTwoPotential &&
    i.squad === 'senior'
      ? {
          rule: 'R-11',
          priority: 50,
          severity: 'watch',
          tag: 'Loan out',
          line: `Third choice at ${i.age} behind higher ceilings. They need games elsewhere.`,
          evidence: `depth rank ${i.depthRank}, potential ${i.potential} vs ${i.depthRankTwoPotential} ahead of them`,
        }
      : null,

  // R-15 academy contract running down.
  //
  // Important about what this is and is not. The game has its own notification —
  // "the player wants to terminate his contract, your assistant has asked for
  // time" — and **that message is not in the save**. No table carries an
  // unsettled or termination flag; `career_youthplayers` has only tier, months in
  // squad and the potential range.
  //
  // So this is not that message relayed. It is a count of the months left on the
  // deal, which the save does carry, and it fires *earlier* — while there is
  // still a season to act in, rather than at the point the game gives you a
  // deadline. Treat it as the early warning; the game's own message is the last
  // call.
  //
  // Priority sits above everything but a ceiling collapse: a 91-potential
  // prospect walking for nothing is the most expensive thing that can quietly
  // happen in a career.
  (i) =>
    i.squad === 'academy' &&
    i.contractMonths !== null &&
    i.contractMonths <= THRESHOLDS.youthContractWarning &&
    i.potential !== null &&
    i.potential >= THRESHOLDS.youthWorthKeeping
      ? {
          rule: 'R-15',
          priority: i.contractMonths <= THRESHOLDS.youthContractUrgent ? 98 : 88,
          severity: i.contractMonths <= THRESHOLDS.youthContractUrgent ? 'urgent' : 'action',
          tag: 'Sign to senior',
          line:
            `Academy deal has ${term(i.contractMonths)} left on a ${i.potential} ceiling. ` +
            'Offer a contract in game while you still have room to.',
          evidence:
            `${term(i.contractMonths)} left, potential ${i.potential}, age ${i.age ?? 'unknown'}. ` +
            'Counted from the contract in the save. The game’s own "wants to terminate" ' +
            'message is not stored, so this fires earlier than that warning, not from it.',
        }
      : null,

  // R-12 protect in academy.
  (i) =>
    i.squad === 'academy' &&
    i.potential !== null &&
    i.potential >= THRESHOLDS.academyPotential &&
    i.age !== null &&
    i.age <= THRESHOLDS.academyAge
      ? {
          rule: 'R-12',
          priority: 45,
          severity: 'watch',
          tag: 'Keep in academy',
          line: `${i.potential} ceiling at ${i.age}. Keep them playing in the academy, not parked on a senior bench.`,
          evidence: `potential ${i.potential}, age ${i.age}`,
        }
      : null,

  // R-13 selection cost.
  (i) =>
    i.selectionCost !== null && i.selectionCost.fitCost >= THRESHOLDS.selectionFitCost
      ? {
          rule: 'R-13',
          priority: 40,
          severity: 'watch',
          tag: 'Bench',
          line: `${i.selectionCost.instead} fits ${i.selectionCost.slot} ${i.selectionCost.fitCost} better than your saved pick.`,
          evidence: `computed fit difference at ${i.selectionCost.slot}`,
        }
      : null,

  // R-14 renew before value is lost.
  (i) =>
    i.contractMonths !== null &&
    i.contractMonths <= THRESHOLDS.contractMonthsUrgent &&
    i.headroom !== null &&
    i.headroom >= THRESHOLDS.renewHeadroom
      ? {
          rule: 'R-14',
          priority: 35,
          severity: 'urgent',
          tag: 'Renew',
          line: `${term(i.contractMonths)} left with ${i.headroom} still to grow. Renew or lose a free transfer.`,
          evidence: `${term(i.contractMonths)} left, growth left ${i.headroom}`,
        }
      : null,

  // R-99 always.
  () => ({
    rule: 'R-99',
    priority: 10,
    severity: 'steady',
    tag: 'Steady',
    line: 'Nothing urgent.',
    evidence: 'no higher-priority rule fired',
  }),
];

export interface RuleResult {
  /** The line the card shows. */
  primary: Advice;
  /** Everything else that fired, highest first. */
  others: Advice[];
}

export function evaluate(input: RuleInput): RuleResult {
  const fired = RULES.map((rule) => rule(input))
    .filter((a): a is Advice => a !== null)
    .sort((a, b) => b.priority - a.priority);

  // R-99 guarantees at least one.
  const [primary, ...others] = fired as [Advice, ...Advice[]];
  return { primary, others };
}

export interface AlertLine extends Advice {
  playerId: number;
  playerName: string;
  squad: 'senior' | 'academy';
}

/**
 * The alert rail: the firings worth interrupting for, across the whole club.
 * "Steady" never appears — a rail full of nothing to do is a rail nobody reads.
 */
export function alertRail(results: { input: RuleInput; result: RuleResult }[]): AlertLine[] {
  const lines: AlertLine[] = [];

  for (const { input, result } of results) {
    for (const advice of [result.primary, ...result.others]) {
      if (advice.severity === 'steady') continue;
      lines.push({
        ...advice,
        playerId: input.playerId,
        playerName: input.name,
        squad: input.squad,
      });
    }
  }

  const order: Record<Severity, number> = { urgent: 0, action: 1, watch: 2, steady: 3 };
  return lines.sort(
    (a, b) => order[a.severity] - order[b.severity] || b.priority - a.priority || a.playerName.localeCompare(b.playerName),
  );
}

/** Injuries are a fact, not a rule firing, but the rail should carry them. */
export function availabilityAlerts(
  players: { playerId: number; name: string; injured: boolean; squad: 'senior' | 'academy' }[],
): AlertLine[] {
  return players
    .filter((p) => p.injured)
    .map((p) => ({
      rule: 'R-99' as RuleId,
      priority: 95,
      severity: 'action' as Severity,
      tag: 'Injured',
      line: `${p.name} is injured and unavailable.`,
      evidence: 'teamplayerlinks.injury is non-zero',
      playerId: p.playerId,
      playerName: p.name,
      squad: p.squad,
    }));
}
