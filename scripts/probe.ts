/**
 * Phase 0 probe: parse a real save and print what came out.
 *
 * Prints, does not render. Its whole job is to make the spine visible before any
 * UI exists. Run with `npm run probe` (newest save) or `npm run probe -- <path>`.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave, type Row, type Tables } from '../src/parser/dbReader.ts';
import {
  findLatestManagerCareerSave,
  resolveSaveDirectory,
  YOUTH_TEAM_ID,
  listManagerCareerSaves,
} from '../src/core/saveLocation.ts';
import { createNameResolver, loadNameTable } from '../src/names/nameTable.ts';
import { deriveNameIds } from '../src/names/deriveNameTable.ts';

const META_PATH = fileURLToPath(new URL('../data/fifa_ng_db-meta.xml', import.meta.url));
const NAMES_PATH = fileURLToPath(new URL('../data/playernames_fc26.csv', import.meta.url));

const num = (row: Row | undefined, key: string): number | null => {
  const v = row?.[key];
  return typeof v === 'number' ? v : null;
};
const str = (row: Row | undefined, key: string): string | null => {
  const v = row?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
};
const rows = (t: Tables, name: string): Row[] => t[name] ?? [];

function allTables(meta: ReturnType<typeof loadDbMeta>): Tables[] {
  // Ballots are stronger with more saves: every career is more evidence for the
  // same base nameid table (spec.md §2.5a).
  const dir = resolveSaveDirectory();
  if (!dir) return [];
  return listManagerCareerSaves(dir).map((s) => parseSave(readFileSync(s.path), meta).tables);
}

function main(): void {
  const explicit = process.argv[2];
  const save = explicit
    ? { path: explicit, fileName: basename(explicit) }
    : findLatestManagerCareerSave();

  if (!save) {
    const dir = resolveSaveDirectory();
    console.error(
      dir
        ? `No CmMgrC* Manager Career save found in ${dir}`
        : 'No FC 26 settings directory found. Is the game installed for this user?',
    );
    process.exit(1);
  }

  console.log(`meta   ${META_PATH}`);
  const meta = loadDbMeta(META_PATH);
  console.log(`       ${meta.tableNames.size} tables, ${meta.fieldNames.size} fields known\n`);

  const bytes = readFileSync(save.path);
  console.log(`save   ${save.fileName}  ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);

  const startedAt = performance.now();
  const result = parseSave(bytes, meta);
  const elapsed = Math.round(performance.now() - startedAt);
  const t = result.tables;

  console.log(`parse  ${elapsed} ms, ${result.databases.length} databases\n`);
  for (const db of result.databases) {
    console.log(`  DB${db.index}: ${db.tables.length} tables`);
  }

  // Integrity: what the meta XML could not name.
  const unknownFieldTables = result.stats.filter((s) => s.unknownFields.length > 0);
  console.log(`\nunknown tables: ${result.unknownTables.join(', ') || 'none'}`);
  for (const s of unknownFieldTables) {
    console.log(`unknown fields in ${s.table}: ${s.unknownFields.length}/${s.fields}`);
  }

  // Career identity.
  const user = rows(t, 'career_users')[0];
  const managerInfo = rows(t, 'career_managerinfo')[0];
  const clubId = num(managerInfo, 'clubteamid') ?? num(user, 'clubteamid');
  const club = rows(t, 'teams').find((r) => num(r, 'teamid') === clubId);

  console.log(
    `\ncareer  ${[str(user, 'firstname'), str(user, 'surname')].filter(Boolean).join(' ') || 'unknown'}` +
      `  ·  ${str(club, 'teamname') ?? `#${clubId}`}` +
      `  ·  season ${num(user, 'seasoncount') ?? '?'}`,
  );
  console.log(
    `club    OVR ${num(club, 'overallrating')}  ATT ${num(club, 'attackrating')}` +
      `  MID ${num(club, 'midfieldrating')}  DEF ${num(club, 'defenserating')}` +
      `  worth ${(num(club, 'clubworth') ?? 0).toLocaleString('en-GB')}`,
  );

  // In-game date is not directly readable (spec.md §9 D-1). Derive an upper bound
  // from the latest dated row and label it an estimate — never present it as fact.
  const dateFields: [string, string][] = [
    ['persistent_events', 'eventdate'],
    ['career_playermatchratinghistory', 'date'],
    ['career_presignedcontract', 'signeddate'],
  ];
  let latest = 0;
  for (const [table, field] of dateFields) {
    for (const row of rows(t, table)) {
      const v = num(row, field);
      if (v && v > latest) latest = v;
    }
  }
  const iso = latest ? `${String(latest).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}` : 'unknown';
  console.log(`date    ~${iso}  (estimated, spec.md D-1; career_calendar.currdate is a dead template)`);

  // Squad. Names resolve through the save's own strings, then an imported
  // playerid table, then #id — never a guess (spec.md §2.5).
  const nameTable = loadNameTable(NAMES_PATH);
  const derived = deriveNameIds(allTables(meta), nameTable);
  const resolver = createNameResolver(t, nameTable, derived);
  const players = new Map(rows(t, 'players').map((p) => [num(p, 'playerid'), p]));
  const squad = rows(t, 'teamplayerlinks')
    .filter((l) => num(l, 'teamid') === clubId)
    .sort((a, b) => (num(b, 'overallrating') ?? 0) - (num(a, 'overallrating') ?? 0));

  const coverage = resolver.coverage(
    squad.map((l) => num(l, 'playerid')).filter((v): v is number => v !== null),
  );
  console.log(
    `\nsquad   ${squad.length} players (${players.size} in save)` +
      `  ·  names ${coverage.resolved}/${coverage.total}` +
      (nameTable.source ? '' : '  (no name table — run: npm run import:names)') +
      '\n',
  );
  console.log('   #  player                     OVR  POT  hd  pos  ht   wt  ft SM WF  until  form inj');
  console.log('  ' + '-'.repeat(88));

  const bySquadOvr = squad
    .map((link) => ({ link, player: players.get(num(link, 'playerid')) }))
    .filter((x): x is { link: Row; player: Row } => x.player !== undefined)
    .sort((a, b) => (num(b.player, 'overallrating') ?? 0) - (num(a.player, 'overallrating') ?? 0));

  for (const { link, player } of bySquadOvr) {
    const id = num(player, 'playerid')!;
    const resolved = resolver.resolve(id);
    const name = resolved.display + (resolved.provisional ? ' ~' : '');
    const ovr = num(player, 'overallrating') ?? 0;
    const pot = num(player, 'potential') ?? 0;
    console.log(
      '  ' +
        String(num(link, 'jerseynumber') ?? '').padStart(3) +
        '  ' +
        name.padEnd(24) +
        String(ovr).padStart(4) +
        String(pot).padStart(5) +
        String(pot - ovr).padStart(4) +
        String(num(link, 'position') ?? '').padStart(5) +
        String(num(player, 'height') ?? '').padStart(5) +
        String(num(player, 'weight') ?? '').padStart(5) +
        (num(player, 'preferredfoot') === 2 ? '  L' : '  R') +
        String(num(player, 'skillmoves') ?? '').padStart(3) +
        String(num(player, 'weakfootabilitytypecode') ?? '').padStart(3) +
        String(num(player, 'contractvaliduntil') ?? '').padStart(7) +
        String(num(link, 'form') ?? '').padStart(6) +
        String(num(link, 'injury') ?? '').padStart(4),
    );
  }

  // Youth academy. `career_youthplayers` can hold rows with no matching `players`
  // record — a prospect the game never fully generated. Those are not cards.
  const youthIds = new Set<number>();
  for (const y of rows(t, 'career_youthplayers')) {
    const id = num(y, 'playerid');
    if (id !== null) youthIds.add(id);
  }
  for (const l of rows(t, 'teamplayerlinks')) {
    if (num(l, 'teamid') === YOUTH_TEAM_ID) {
      const id = num(l, 'playerid');
      if (id !== null) youthIds.add(id);
    }
  }

  const youthRows = rows(t, 'career_youthplayers');
  const youthById = new Map(youthRows.map((y) => [num(y, 'playerid'), y]));
  const real = [...youthIds].filter((id) => players.has(id));
  const orphans = [...youthIds].filter((id) => !players.has(id));
  const youthCoverage = resolver.coverage(real);

  console.log(
    `\nacademy ${real.length} prospects  ·  names ${youthCoverage.resolved}/${youthCoverage.total}` +
      (orphans.length ? `  ·  ${orphans.length} orphan row(s) skipped: ${orphans.join(', ')}` : ''),
  );
  console.log('        player                      OVR  POT  swing  var  months  tier  club');
  console.log('  ' + '-'.repeat(82));

  for (const id of real.sort((a, b) => (num(players.get(b), 'potential') ?? 0) - (num(players.get(a), 'potential') ?? 0))) {
    const p = players.get(id)!;
    const y = youthById.get(id);
    const resolved = resolver.resolve(id);
    const link = rows(t, 'teamplayerlinks').find((l) => num(l, 'playerid') === id);
    console.log(
      '        ' +
        (resolved.display + (resolved.provisional ? ' ~' : '')).padEnd(28) +
        String(num(p, 'overallrating') ?? '').padStart(3) +
        String(num(p, 'potential') ?? '').padStart(5) +
        String(num(y, 'swinglowpotential') ?? '-').padStart(7) +
        String(num(y, 'potentialvariance') ?? '-').padStart(5) +
        String(num(y, 'monthsinsquad') ?? '-').padStart(8) +
        String(num(y, 'playertier') ?? '-').padStart(6) +
        '  ' +
        (num(link, 'teamid') === clubId ? 'senior' : num(link, 'teamid') === YOUTH_TEAM_ID ? 'academy' : `#${num(link, 'teamid') ?? '?'}`),
    );
  }

  // The tables the engine will actually read (spec.md §1.6).
  console.log('\ncareer tables available to the engine:');
  const engineTables = [
    'cm_teamsheets',
    'cm_mentalities',
    'formations',
    'career_playercontract',
    'career_playermatchratinghistory',
    'career_playergrowthuserseason',
    'career_youthplayers',
    'career_scouts',
    'career_scoutmission',
    'career_managerhistory',
    'playerloans',
    'career_transferblock',
    'career_presignedcontract',
  ];
  for (const name of engineTables) {
    console.log(`  ${name.padEnd(34)} ${String(rows(t, name).length).padStart(6)} rows`);
  }

  // Absences the spec cut features for (spec.md §1.7). Assert they are still absent.
  const allFields = new Set<string>();
  for (const [table, list] of Object.entries(t)) {
    for (const key of Object.keys(list[0] ?? {})) allFields.add(`${table}.${key}`);
  }
  const absent = (label: string, re: RegExp): void => {
    const hits = [...allFields].filter((f) => re.test(f));
    console.log(`  ${label.padEnd(34)} ${hits.length === 0 ? 'absent (confirmed)' : hits.join(' ')}`);
  };
  console.log('\nfields the spec cut features for:');
  absent('development plan', /\b(development|training)plan|playerplan/i);
  absent('sharpness / fitness / fatigue', /sharp|fitness|fatigue|condition/i);
  absent('fixture list', /fixture|schedule|nextmatch|nextopponent/i);
}

main();
