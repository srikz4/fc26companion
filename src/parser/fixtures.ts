/**
 * The fixture ledger, cracked 2026-08-29.
 *
 * Two sections of the tagged career blob carry the season's matches.
 *
 * `mlop` — the calendar. Every fixture of every competition the save simulates,
 * as fixed 22-byte records anchored on the date:
 *
 *   +0  u32  date YYYYMMDD
 *   +4  u16  kick-off, HHMM (2000, 1945, 1500, 1245 …)
 *   +6  u16  participant slot A
 *   +8  u8   goals A   (0xff before the match is played)
 *   +9  u8   0xff      separator
 *   +10 u16  participant slot B
 *   +12 u8   goals B
 *   +13 u8   0xff      separator
 *   +19 u16  competition id, internal to the save
 *
 * The participants are NOT team ids. They are per-competition slot indices in a
 * contiguous block — the Premier League occupies twenty consecutive slots — and
 * within one round slot A + slot B is constant, the signature of a circle-method
 * round robin. The block order is shuffled per save: it matches no ordering of
 * `leagueteamlinks`, of team id, of table position or of rating, and the save
 * holds no array mapping slot to club. So a slot is named only when observation
 * names it, which is what `mrni` is for.
 *
 * `mrni` — the results round-up, the feed the game shows after a matchday. Here
 * the clubs ARE real team ids, in 49-byte records:
 *
 *   +0  u32  date          +6  u32  home team id
 *   +10 u32  away team id  +14 u32  home goals
 *   +18 u32  away goals    +22 u16  league id
 *   +26 u32  the match's standout player
 *
 * It covers only the most recent round, and only the headline leagues. Matching
 * one of its results onto the `mlop` record with the same date and scoreline is
 * what ties a slot to a club — a fact read from the save, never a guess. Slots
 * no round has yet named stay unnamed.
 *
 * Verified end to end against a live save: `mrni` reports Manchester United 4-0
 * Liverpool on 2027-09-11, and the standings derived from the `mlop` group that
 * fixture belongs to reproduce the in-game table row for row.
 */

export interface BlobSection {
  tag: string;
  /** Offset of the `01 <len> <tag>` marker. */
  start: number;
  /** Offset of the next marker, or end of file. */
  end: number;
}

const DB_HEADER = Buffer.from([0x44, 0x42, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);

/** Where the tagged blob starts: just past the last `DB\0\x08` database. */
function blobStart(save: Buffer): number {
  let at = save.indexOf(DB_HEADER);
  if (at < 0) return -1;
  let past = 0;
  while (at >= 0) {
    const size = save.readUInt32LE(at + 8);
    if (size <= 0 || at + size > save.length) break;
    past = at + size;
    at = save.indexOf(DB_HEADER, past);
  }
  return past;
}

/** Every `01 <u32 len=4> <four lowercase letters>` section, in file order. */
export function blobSections(save: Buffer): BlobSection[] {
  const from = blobStart(save);
  if (from <= 0) return [];
  const marks: { tag: string; at: number }[] = [];
  for (let i = from; i < save.length - 12; i++) {
    if (save[i] !== 0x01 || save.readUInt32LE(i + 1) !== 4) continue;
    const tag = save.subarray(i + 5, i + 9).toString('latin1');
    if (!/^[a-z]{4}$/.test(tag)) continue;
    marks.push({ tag, at: i });
    i += 8;
  }
  return marks.map((m, i) => ({
    tag: m.tag,
    start: m.at,
    end: i + 1 < marks.length ? marks[i + 1]!.at : save.length,
  }));
}

/** A slot is a participant we cannot name until a result names it. */
export const UNKNOWN_SLOT = 0xffff;

export interface SlotFixture {
  /** YYYYMMDD. */
  date: number;
  /** Kick-off as HHMM, or null when the save does not carry one. */
  kickoff: number | null;
  /** Competition id, internal to the save — meaningful only for grouping. */
  comp: number;
  slotA: number;
  slotB: number;
  /** Goals, or null when the fixture has not been played. */
  goalsA: number | null;
  goalsB: number | null;
}

const FIXTURE_STRIDE = 22;
/** No football match in the save's own data has ever exceeded this. */
const MAX_GOALS = 30;

function plausibleDate(v: number): boolean {
  if (v < 20200101 || v > 20600101) return false;
  const month = Math.floor((v % 10000) / 100);
  const day = v % 100;
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function readGoals(v: number): number | null | false {
  if (v === 0xff) return null; // not played yet
  if (v > MAX_GOALS) return false; // not a scoreline; reject the record
  return v;
}

/**
 * The full fixture calendar, in slot terms.
 *
 * Returns null when the section is missing or yields nothing that validates —
 * an unreadable calendar, never an empty one.
 */
export function readFixtureLedger(save: Buffer): SlotFixture[] | null {
  const section = blobSections(save).find((s) => s.tag === 'mlop');
  if (!section) return null;

  const out: SlotFixture[] = [];
  for (let i = section.start; i + FIXTURE_STRIDE <= section.end; i++) {
    if (save[i + 9] !== 0xff || save[i + 13] !== 0xff) continue;
    const date = save.readUInt32LE(i);
    if (!plausibleDate(date)) continue;
    const goalsA = readGoals(save[i + 8]!);
    const goalsB = readGoals(save[i + 12]!);
    if (goalsA === false || goalsB === false) continue;
    const kickoff = save.readUInt16LE(i + 4);
    out.push({
      date,
      kickoff: kickoff >= 0 && kickoff <= 2359 ? kickoff : null,
      comp: save.readUInt16LE(i + 19),
      slotA: save.readUInt16LE(i + 6),
      slotB: save.readUInt16LE(i + 10),
      goalsA,
      goalsB,
    });
  }
  return out.length ? out : null;
}

export interface RoundResult {
  date: number;
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
  leagueId: number;
  /** The player the round-up singles out, when the save names one. */
  standoutPlayerId: number | null;
}

const RESULT_STRIDE = 49;

/**
 * The most recent round's results, with real club ids.
 *
 * Every record must name two different clubs that share a league, or it is not
 * a result and is dropped.
 */
export function readLatestResults(
  save: Buffer,
  leagueOfTeam: (teamId: number) => number | null,
  isPlayerId: (id: number) => boolean = () => false,
): RoundResult[] | null {
  const section = blobSections(save).find((s) => s.tag === 'mrni');
  if (!section) return null;

  const out: RoundResult[] = [];
  const seen = new Set<string>();
  for (let i = section.start; i + RESULT_STRIDE <= section.end; i++) {
    const date = save.readUInt32LE(i);
    if (!plausibleDate(date)) continue;
    const home = save.readUInt32LE(i + 6);
    const away = save.readUInt32LE(i + 10);
    if (home === away) continue;
    const league = leagueOfTeam(home);
    if (league === null || league !== leagueOfTeam(away)) continue;
    const hg = save.readUInt32LE(i + 14);
    const ag = save.readUInt32LE(i + 18);
    if (hg > MAX_GOALS || ag > MAX_GOALS) continue;
    if (save.readUInt16LE(i + 22) !== league) continue;

    // The round-up repeats the user's own match; keep one copy.
    const key = `${date}:${home}:${away}:${hg}:${ag}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const standout = save.readUInt32LE(i + 26);
    out.push({
      date,
      homeTeamId: home,
      awayTeamId: away,
      homeGoals: hg,
      awayGoals: ag,
      leagueId: league,
      standoutPlayerId: isPlayerId(standout) ? standout : null,
    });
  }
  return out.length ? out : null;
}
