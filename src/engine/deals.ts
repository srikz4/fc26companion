/**
 * The transfer market this world has actually produced.
 *
 * FC 26 stores no player market value — a sweep of all tables finds nothing —
 * but `career_presignedcontract` records every agreed future transfer in the
 * world: buyer, fee, wage, completion date, and the player. Those are observed
 * prices, and a handful of observed prices beats an invented value table.
 *
 * The fee model is ordinary least squares on the log of the fee against the
 * player's overall, age and potential, fitted on those observed deals and
 * reported with its spread: `estimate()` returns a low–mid–high band where low
 * and high are one residual standard deviation either side, in fee space. With
 * a dozen-odd samples that band is wide, and showing it wide is the point —
 * a range fitted on 15 real deals, honestly labelled, over a made-up number.
 *
 * The model refuses to extrapolate. A log-linear fit behaves inside the range it
 * was fitted on and explodes outside it — the first live run priced a 92-rated
 * wonderkid at 643M–2.5B, because no deal in this world has gone past 50M and
 * the exponential kept climbing anyway. A player beyond the observed market
 * gets null, and the UI says so: "bigger than any deal this world has done".
 */
import type { Row } from '../parser/dbReader.ts';

const num = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;

export interface DealRecord {
  playerId: number;
  name: string;
  fee: number;
  wage: number | null;
  toTeamId: number | null;
  toTeamName: string | null;
  /** The club selling. */
  fromTeamId: number | null;
  fromTeamName: string | null;
  overall: number | null;
  potential: number | null;
  age: number | null;
  completes: string | null;
}

export interface FeeEstimate {
  low: number;
  mid: number;
  high: number;
  /** How many observed deals the model stands on. */
  sample: number;
}

export interface DealsModel {
  deals: DealRecord[];
  /** Null when the world has too few priced deals to fit anything. The function
   * itself returns null for a player outside the observed market's range. */
  estimate: ((overall: number, age: number, potential: number) => FeeEstimate | null) | null;
  /** What this world pays a player of that profile, per week. */
  wageEstimate: ((overall: number, age: number, potential: number) => FeeEstimate | null) | null;
  sample: number;
}

const fmtDate = (n: number | null): string | null =>
  n === null ? null : String(n).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

/** Gaussian elimination for the tiny normal-equations system. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-9) return null;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

export function buildDealsModel(
  presigned: Row[],
  playerById: Map<number, Row>,
  teamNames: Map<number, string>,
  nameOf: (id: number) => string,
  ageOf: (player: Row) => number | null,
  /** Your club, whose own deals are kept out of the fit. */
  ourClubId: number | null = null,
): DealsModel {
  const deals: DealRecord[] = [];

  for (const row of presigned) {
    const playerId = num(row, 'playerid');
    const fee = num(row, 'offeredfee');
    if (playerId === null || fee === null || fee <= 0) continue;

    const player = playerById.get(playerId);
    /**
     * `offerteamid` is the club doing the buying; `teamid` is the club being
     * bought from. Reading the seller as the destination had every deal
     * pointing the wrong way — Henrichs "to AS Monaco" when Monaco were selling
     * him to Everton.
     */
    const toTeamId = num(row, 'offerteamid');
    const fromTeamId = num(row, 'teamid');
    deals.push({
      playerId,
      name: nameOf(playerId),
      fee,
      wage: num(row, 'offeredwage'),
      toTeamId,
      toTeamName: toTeamId === null ? null : (teamNames.get(toTeamId) ?? null),
      fromTeamId,
      fromTeamName: fromTeamId === null ? null : (teamNames.get(fromTeamId) ?? null),
      overall: num(player, 'overallrating'),
      potential: num(player, 'potential'),
      age: player ? ageOf(player) : null,
      completes: fmtDate(num(row, 'completedate')),
    });
  }
  deals.sort((a, b) => b.fee - a.fee);

  /**
   * Fit log(fee) = a + b·overall + c·age + d·potential — on OTHER clubs' deals.
   *
   * Your own signings are excluded, and that is the whole point of the model.
   * It is meant to answer "what does this world pay", so that you can tell
   * whether your offer is sane. Training it on your own offers makes it agree
   * with you by construction: two signings at 90M and 110M pulled the top of
   * the fitted market up to match them, and it went on to price a comparable
   * player at 115M when the selling club would in fact have taken 74M.
   *
   * They stay in the displayed list — they are real deals in this world and
   * worth seeing — they just do not get a vote on what things cost.
   */
  const usable = deals.filter(
    (d) =>
      d.overall !== null &&
      d.age !== null &&
      d.potential !== null &&
      d.fee >= 10000 &&
      (ourClubId === null || d.toTeamId !== ourClubId),
  );

  /**
   * The same fit, over whatever number a deal carries.
   *
   * Fees and wages are priced by the same three things — how good he is, how
   * old he is, how much better he might get — and both spread multiplicatively,
   * so both want a log-linear fit and a band one residual either side. Sharing
   * the machinery means the wage guide inherits the fee guide's refusal to
   * extrapolate, which is the part that matters: a curve fitted between 77 and
   * 91 overall says nothing trustworthy about a 94, and should say so.
   */
  const fitBand = (
    rows: DealRecord[],
    valueOf: (d: DealRecord) => number | null,
    roundTo: (v: number) => number,
  ): DealsModel['estimate'] => {
    const points = rows
      .map((d) => ({ d, v: valueOf(d) }))
      .filter((x): x is { d: DealRecord; v: number } => x.v !== null && x.v > 0);
    if (points.length < 8) return null;

    const dims = 4;
    const A = Array.from({ length: dims }, () => new Array(dims).fill(0));
    const b = new Array(dims).fill(0);
    for (const { d, v } of points) {
      const row = [1, d.overall!, d.age!, d.potential!];
      const y = Math.log(v);
      for (let j = 0; j < dims; j++) {
        b[j] += row[j]! * y;
        for (let k = 0; k < dims; k++) A[j]![k]! += row[j]! * row[k]!;
      }
    }
    for (let j = 0; j < dims; j++) A[j]![j]! += 1e-6;
    const coef = solve(A, b);
    if (!coef) return null;

    const residuals = points.map(({ d, v }) =>
      Math.log(v) - (coef[0]! + coef[1]! * d.overall! + coef[2]! * d.age! + coef[3]! * d.potential!),
    );
    const sd = Math.sqrt(residuals.reduce((acc, r) => acc + r * r, 0) / residuals.length) || 0.5;
    const maxOverall = Math.max(...points.map((x) => x.d.overall!));
    const minOverall = Math.min(...points.map((x) => x.d.overall!));
    const cap = Math.max(...points.map((x) => x.v)) * 1.6;
    const sample = points.length;

    return (overall, age, potential) => {
      if (overall > maxOverall + 2 || overall < minOverall - 4) return null;
      const mid = Math.exp(coef[0]! + coef[1]! * overall + coef[2]! * age + coef[3]! * potential);
      return {
        low: roundTo(Math.min(mid * Math.exp(-sd), cap)),
        mid: roundTo(Math.min(mid, cap)),
        high: roundTo(Math.min(mid * Math.exp(sd), cap)),
        sample,
      };
    };
  };

  // Wages land in the thousands, not the millions, so they round differently.
  const wageEstimate = fitBand(
    usable,
    (d) => d.wage,
    (v) => {
      const magnitude = v >= 100_000 ? 5000 : v >= 20_000 ? 1000 : 500;
      return Math.max(magnitude, Math.round(v / magnitude) * magnitude);
    },
  );

  let estimate: DealsModel['estimate'] = null;
  if (usable.length >= 8) {
    const X = usable.map((d) => [1, d.overall!, d.age!, d.potential!]);
    const y = usable.map((d) => Math.log(d.fee));

    const dims = 4;
    const A = Array.from({ length: dims }, () => new Array(dims).fill(0));
    const b = new Array(dims).fill(0);
    for (let i = 0; i < X.length; i++) {
      for (let j = 0; j < dims; j++) {
        b[j] += X[i]![j]! * y[i]!;
        for (let k = 0; k < dims; k++) A[j]![k]! += X[i]![j]! * X[i]![k]!;
      }
    }
    for (let j = 0; j < dims; j++) A[j]![j]! += 1e-6;

    const maxOverall = Math.max(...usable.map((d) => d.overall!));
    const minOverall = Math.min(...usable.map((d) => d.overall!));
    const maxFee = Math.max(...usable.map((d) => d.fee));

    const coef = solve(A, b);
    if (coef) {
      const residuals = usable.map((d, i) => {
        const pred = coef[0]! + coef[1]! * d.overall! + coef[2]! * d.age! + coef[3]! * d.potential!;
        return y[i]! - pred;
      });
      const sd = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length) || 0.5;
      const sample = usable.length;

      const round = (v: number): number => {
        const magnitude = v >= 20_000_000 ? 1_000_000 : v >= 2_000_000 ? 250_000 : 50_000;
        return Math.max(magnitude, Math.round(v / magnitude) * magnitude);
      };

      estimate = (overall, age, potential) => {
        // Interpolation only: outside the band of players this market has
        // actually priced, say nothing rather than something exponential.
        if (overall > maxOverall + 2 || overall < minOverall - 4) return null;
        const mid = Math.exp(coef[0]! + coef[1]! * overall + coef[2]! * age + coef[3]! * potential);
        const cap = maxFee * 1.6;
        return {
          low: round(Math.min(mid * Math.exp(-sd), cap)),
          mid: round(Math.min(mid, cap)),
          high: round(Math.min(mid * Math.exp(sd), cap)),
          sample,
        };
      };
    }
  }

  return { deals: deals.slice(0, 20), estimate, wageEstimate, sample: usable.length };
}
