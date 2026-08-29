/**
 * Where does the game keep a player's season statistics?
 *
 *   npm run experiment:baseline    # before
 *   ...play one match in which ONE named player scores exactly one goal...
 *   npm run experiment:stats -- <playerId>
 *
 * The Squad Hub shows appearances, goals, assists, clean sheets and cards per
 * competition, and Companion cannot show any of it: `leagueappearances` is zero
 * for every player, and `leaguegoals` disagrees with the game's own screen.
 * Searching a single save for a field holding a known total found nothing, so
 * the question becomes what MOVES rather than what matches.
 *
 * One goal by one player is about the smallest change a match can make. This
 * looks for it three ways, because the shape of the record is unknown:
 *
 *  1. Database fields, where offsets are stable and a changed column is
 *     obvious. If a counter for that player moved by one, it is named outright.
 *  2. Blob bytes near the player's id, for a record that keeps his stats
 *     beside his name.
 *  3. Any byte in the file that went from the old value to the new one, when
 *     both are known — the last resort, and noisy, so it is reported as counts
 *     by section rather than as a list.
 *
 * The blob is variable-length, so a single insertion shifts every offset after
 * it and a raw byte diff is mostly noise. That is why the searches are anchored
 * on the player rather than on position.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave, type Tables } from '../src/parser/dbReader.ts';
import { findLatestManagerCareerSave } from '../src/core/saveLocation.ts';
import { blobSections } from '../src/parser/fixtures.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const BASELINE = join(root, 'store', 'experiment', 'baseline.bin');
const meta = loadDbMeta(join(root, 'data', 'fifa_ng_db-meta.xml'));

const playerArg = Number(process.argv[2]);
if (!Number.isInteger(playerArg)) {
  console.error('Give the player id who scored:  npm run experiment:stats -- 260592');
  process.exit(1);
}
if (!existsSync(BASELINE)) {
  console.error('No baseline. Run `npm run experiment:baseline` before the match.');
  process.exit(1);
}

const before = readFileSync(BASELINE);
const live = findLatestManagerCareerSave();
if (!live) {
  console.error('No save found.');
  process.exit(1);
}
const after = readFileSync(live.path);
if (before.equals(after)) {
  console.error('The newest save is the baseline itself — play the match and save first.');
  process.exit(1);
}
console.log(`before  ${before.length.toLocaleString('en-GB')} bytes`);
console.log(`after   ${live.path}\n`);

const num = (row: Record<string, unknown> | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;

// ---------------------------------------------------------------- 1. tables
const tBefore: Tables = parseSave(before, meta).tables;
const tAfter: Tables = parseSave(after, meta).tables;

console.log('=== database fields that moved for this player ===');
let tableHits = 0;
for (const name of Object.keys(tAfter)) {
  const rowsA = tBefore[name] ?? [];
  const rowsB = tAfter[name] ?? [];
  const key = Object.keys(rowsB[0] ?? {}).find((k) => /playerid|player1id/.test(k));
  if (!key) continue;
  const pick = (rows: Record<string, unknown>[]) => rows.filter((r) => num(r, key) === playerArg);
  const a = pick(rowsA);
  const b = pick(rowsB);
  if (a.length !== b.length) {
    console.log(`  ${name}: ${a.length} row(s) -> ${b.length} row(s)`);
    tableHits++;
    for (const row of b.slice(a.length)) console.log(`     new: ${JSON.stringify(row)}`);
    continue;
  }
  for (let i = 0; i < b.length; i++) {
    for (const col of Object.keys(b[i]!)) {
      const x = num(a[i], col);
      const y = num(b[i], col);
      if (x !== y && (x !== null || y !== null)) {
        console.log(`  ${name}.${col}: ${x} -> ${y}${y !== null && x !== null ? `  (${y - x > 0 ? '+' : ''}${y - x})` : ''}`);
        tableHits++;
      }
    }
  }
}
if (!tableHits) console.log('  (nothing in any parsed table moved for him)');

// ---------------------------------------------------------------- 2. blob
const idBytes = Buffer.alloc(4);
idBytes.writeUInt32LE(playerArg);
const occurrences = (buf: Buffer): number[] => {
  const out: number[] = [];
  let at = buf.indexOf(idBytes);
  while (at >= 0) {
    out.push(at);
    at = buf.indexOf(idBytes, at + 1);
  }
  return out;
};
const beforeAt = occurrences(before);
const afterAt = occurrences(after);
console.log(`\n=== the player's id appears ${beforeAt.length} times before, ${afterAt.length} times after ===`);

const secsAfter = blobSections(after);
const sectionOf = (i: number) => secsAfter.find((s) => i >= s.start && i < s.end)?.tag ?? 'DB';

/**
 * A record that keeps his stats beside his id should look almost the same
 * either side of the match, with one or two small numbers a little higher.
 * Compare the windows pairwise in order: the nth mention before against the nth
 * after. Where the blob has shifted this breaks down, so a window that differs
 * wildly is skipped rather than reported.
 */
const WIN = 64;
console.log(`\n=== windows around his id that changed by a small amount ===`);
let windowHits = 0;
for (let k = 0; k < Math.min(beforeAt.length, afterAt.length); k++) {
  const a = before.subarray(Math.max(0, beforeAt[k]! - WIN), beforeAt[k]! + WIN);
  const b = after.subarray(Math.max(0, afterAt[k]! - WIN), afterAt[k]! + WIN);
  if (a.length !== b.length || a.equals(b)) continue;
  const moves: string[] = [];
  let wildly = 0;
  for (let i = 0; i + 4 <= a.length; i++) {
    const x = a.readUInt32LE(i);
    const y = b.readUInt32LE(i);
    if (x === y) continue;
    const d = y - x;
    if (d > 0 && d <= 4) moves.push(`+${d} at ${i - WIN} (${x}->${y})`);
    else wildly++;
  }
  // A shifted window changes everywhere; a stat record changes in one place.
  if (moves.length && wildly < 24) {
    windowHits++;
    console.log(`  #${k} [${sectionOf(afterAt[k]!)}] @${afterAt[k]}`);
    console.log(`     ${moves.slice(0, 12).join('  ')}`);
  }
}
if (!windowHits) console.log('  (no window near his id changed in a way that looks like a counter)');

console.log('\n=== how much of each section moved at all ===');
const secsBefore = blobSections(before);
for (const s of secsAfter) {
  const b0 = secsBefore.find((x) => x.tag === s.tag);
  if (!b0) {
    console.log(`  ${s.tag}: new section`);
    continue;
  }
  const lenA = b0.end - b0.start;
  const lenB = s.end - s.start;
  const n = Math.min(lenA, lenB);
  let changed = 0;
  for (let i = 0; i < n; i++) if (before[b0.start + i] !== after[s.start + i]) changed++;
  const pct = n ? Math.round((changed / n) * 100) : 0;
  if (pct > 0 || lenA !== lenB) {
    console.log(`  ${s.tag}: ${pct}% of bytes differ${lenA !== lenB ? `, size ${lenA} -> ${lenB}` : ''}`);
  }
}
