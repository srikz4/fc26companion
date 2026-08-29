/**
 * The controlled experiment: what does one league match change in the save?
 *
 * Companion cannot show the live league table or the fixture list because
 * neither is in the parsed database — `leagueteamlinks` carries zeros for the
 * user's league, and `currenttableposition` disagrees with what the game shows
 * on screen (spec.md §16). The data is in the tagged career blob, and the way
 * to find it is to remove every other variable:
 *
 *   npm run experiment:baseline   # before
 *   ...play exactly one league match, save, do nothing else...
 *   npm run experiment:diff       # after
 *
 * With a single cause, a section whose bytes move is a candidate for the table
 * or the fixture list. Without that control every section reads as changed,
 * because the blob is variable-length and one insertion shifts every offset
 * after it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave, type Tables, type Row } from '../src/parser/dbReader.ts';
import { findLatestManagerCareerSave } from '../src/core/saveLocation.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(root, 'store', 'experiment');
const BASELINE = join(DIR, 'baseline.bin');
const META_PATH = join(root, 'data', 'fifa_ng_db-meta.xml');

const DB_HEADER = Buffer.from([0x44, 0x42, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);

interface Section {
  tag: string;
  at: number;
  end: number;
}

/** The tagged sections after the last database block. */
function sectionsOf(bytes: Buffer): Section[] {
  let off = bytes.indexOf(DB_HEADER);
  let blobStart = 0;
  while (off >= 0) {
    const size = bytes.readUInt32LE(off + 8);
    blobStart = off + size;
    off = bytes.indexOf(DB_HEADER, off + size);
  }
  const marks: { tag: string; at: number }[] = [];
  for (let i = blobStart; i < bytes.length - 12; i++) {
    if (bytes[i] === 0x01 && bytes.readUInt32LE(i + 1) === 4) {
      const tag = bytes.subarray(i + 5, i + 9).toString('latin1');
      if (/^[a-z]{4}$/.test(tag)) {
        marks.push({ tag, at: i });
        i += 8;
      }
    }
  }
  return marks.map((m, i) => ({
    tag: m.tag,
    at: m.at,
    end: i + 1 < marks.length ? marks[i + 1]!.at : bytes.length,
  }));
}

const num = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;

function capture(): void {
  const save = findLatestManagerCareerSave();
  if (!save) {
    console.error('No save found.');
    process.exit(1);
  }
  const bytes = readFileSync(save.path);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(BASELINE, bytes);
  console.log('Baseline captured.');
  console.log(`  file   ${save.fileName}`);
  console.log(`  bytes  ${bytes.length.toLocaleString('en-GB')}`);
  console.log(`  sha    ${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`);
  console.log('\nNow play exactly one league match, save, and run:  npm run experiment:diff');
  console.log('Do nothing else in between — no transfers, no training, no scouting.');
}

function diff(): void {
  if (!existsSync(BASELINE)) {
    console.error('No baseline. Run: npm run experiment:baseline');
    process.exit(1);
  }
  const save = findLatestManagerCareerSave();
  if (!save) {
    console.error('No save found.');
    process.exit(1);
  }
  const before = readFileSync(BASELINE);
  const after = readFileSync(save.path);
  if (before.equals(after)) {
    console.error('The newest save is byte-identical to the baseline — has the game saved yet?');
    process.exit(1);
  }
  console.log(`before ${before.length.toLocaleString('en-GB')} bytes`);
  console.log(`after  ${after.length.toLocaleString('en-GB')} bytes  (${after.length - before.length >= 0 ? '+' : ''}${after.length - before.length})`);

  const meta = loadDbMeta(META_PATH);
  const A: Tables = parseSave(before, meta).tables;
  const B: Tables = parseSave(after, meta).tables;

  // Which clubs are in our league, so a section that talks about them stands out.
  const user = (B['career_users'] ?? [])[0];
  const info = (B['career_managerinfo'] ?? [])[0];
  const clubId = num(info, 'clubteamid') ?? num(user, 'clubteamid');
  let leagueId: number | null = null;
  for (const l of B['leagueteamlinks'] ?? []) {
    if (num(l, 'teamid') === clubId) leagueId = num(l, 'leagueid');
  }
  const rivals = new Set<number>();
  for (const l of B['leagueteamlinks'] ?? []) {
    if (num(l, 'leagueid') === leagueId) {
      const id = num(l, 'teamid');
      if (id !== null) rivals.add(id);
    }
  }
  console.log(`league ${leagueId} with ${rivals.size} clubs\n`);

  // --- what changed in the parsed tables
  console.log('=== database changes ===');
  const idKeys = ['playerid', 'teamid', 'leagueid', 'artificialkey', 'season', 'scoutid', 'id', 'managerid'];
  const keyOf = (r: Row): string => idKeys.filter((k) => r[k] !== undefined).map((k) => `${k}=${r[k]}`).join(',');
  let tableChanges = 0;
  for (const table of Object.keys(B)) {
    const a = new Map((A[table] ?? []).map((r) => [keyOf(r), r]));
    const notes: string[] = [];
    for (const r of B[table] ?? []) {
      const prev = a.get(keyOf(r));
      if (!prev) {
        if (notes.length < 4) notes.push(`NEW ${keyOf(r)}`);
        continue;
      }
      for (const [k, v] of Object.entries(r)) {
        if (prev[k] === v) continue;
        if (notes.length < 8) notes.push(`${keyOf(r)} ${k}: ${prev[k]} -> ${v}`);
      }
    }
    if (notes.length) {
      tableChanges++;
      console.log(`  ${table}`);
      for (const n of notes) console.log(`      ${n}`);
    }
  }
  if (!tableChanges) console.log('  (nothing)');

  // --- what changed in the blob
  console.log('\n=== blob sections ===');
  const sa = sectionsOf(before);
  const sb = sectionsOf(after);
  const aByTag = new Map(sa.map((s) => [s.tag, s]));
  const rows: { tag: string; delta: number; changed: boolean; rivalsBefore: number; rivalsAfter: number }[] = [];
  const countRivals = (buf: Buffer): number => {
    let n = 0;
    for (let i = 0; i + 4 <= buf.length; i++) if (rivals.has(buf.readUInt32LE(i))) n++;
    return n;
  };
  for (const s of sb) {
    const prev = aByTag.get(s.tag);
    if (!prev) {
      console.log(`  ${s.tag}  NEW SECTION`);
      continue;
    }
    const bBuf = after.subarray(s.at, s.end);
    const aBuf = before.subarray(prev.at, prev.end);
    const changed = !bBuf.equals(aBuf);
    if (!changed) continue;
    rows.push({
      tag: s.tag,
      delta: bBuf.length - aBuf.length,
      changed,
      rivalsBefore: countRivals(aBuf),
      rivalsAfter: countRivals(bBuf),
    });
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  console.log('  tag   size delta   mentions of your league (before -> after)');
  for (const r of rows) {
    const flag = r.rivalsAfter !== r.rivalsBefore ? '  <== league references moved' : '';
    console.log(
      `  ${r.tag}  ${String(r.delta >= 0 ? '+' + r.delta : r.delta).padStart(9)}   ${String(r.rivalsBefore).padStart(6)} -> ${String(r.rivalsAfter).padStart(6)}${flag}`,
    );
  }
  console.log(`\n${rows.length} of ${sb.length} sections changed.`);
  console.log('A section whose league references moved, after a single match, is the candidate.');
}

const mode = process.argv[2] ?? 'diff';
if (mode === 'baseline') capture();
else diff();
