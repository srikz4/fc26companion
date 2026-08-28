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
): DealsModel {
  const deals: DealRecord[] = [];

  for (const row of presigned) {
    const playerId = num(row, 'playerid');
    const fee = num(row, 'offeredfee');
    if (playerId === null || fee === null || fee <= 0) continue;

    const player = playerById.get(playerId);
    const toTeamId = num(row, 'teamid');
    deals.push({
      playerId,
      name: nameOf(playerId),
      fee,
      wage: num(row, 'offeredwage'),
      toTeamId,
      toTeamName: toTeamId === null ? null : (teamNames.get(toTeamId) ?? null),
      overall: num(player, 'overallrating'),
      potential: num(player, 'potential'),
      age: player ? ageOf(player) : null,
      completes: fmtDate(num(row, 'completedate')),
    });
  }
  deals.sort((a, b) => b.fee - a.fee);

  // Fit log(fee) = a + b·overall + c·age + d·potential on complete rows.
  const usable = deals.filter(
    (d) => d.overall !== null && d.age !== null && d.potential !== null && d.fee >= 10000,
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

  return { deals: deals.slice(0, 20), estimate, sample: usable.length };
}
