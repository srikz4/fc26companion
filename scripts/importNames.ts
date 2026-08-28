/**
 * Import a `playerid -> name` table.
 *
 * The FC 26 base name table is not in the save and not readable from the install
 * (spec.md §2.5). This imports a third-party CSV instead, keyed on EA's internal
 * `player_id` — which is what the save gives us, so it sidesteps the re-sorted
 * nameid space entirely.
 *
 *   npm run import:names -- <path-or-url>
 *   npm run import:names            # uses the default source below
 *
 * The importer keeps only `player_id`, `short_name` and `long_name`. Ratings,
 * potential and club in such a file are launch-day values and would contradict
 * the save; names are the one field that is stable identity. Taking anything else
 * from here would violate spec.md §3.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNameTable } from '../src/names/nameTable.ts';

const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/ismailoksuz/EAFC26-DataHub/main/data/players.csv';

const OUTPUT = fileURLToPath(new URL('../data/playernames_fc26.csv', import.meta.url));

async function read(source: string): Promise<string> {
  if (!/^https?:\/\//i.test(source)) {
    if (!existsSync(source)) throw new Error(`no such file: ${source}`);
    return readFileSync(source, 'utf8');
  }
  const response = await fetch(source);
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  const source = process.argv[2] ?? DEFAULT_SOURCE;
  console.log(`source  ${source}`);

  const csv = await read(source);
  console.log(`        ${(csv.length / 1024 / 1024).toFixed(1)} MB`);

  const table = parseNameTable(csv, source);
  console.log(`parsed  ${table.byPlayerId.size.toLocaleString('en-GB')} players`);

  const rows = [...table.byPlayerId.entries()].sort((a, b) => a[0] - b[0]);
  const quote = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

  const out = [
    '# FC 26 player name table. Names only, by EA internal player_id.',
    `# source: ${source}`,
    `# imported: ${new Date().toISOString()}`,
    'player_id,short_name,long_name',
    ...rows.map(([id, n]) => `${id},${quote(n.short)},${quote(n.full)}`),
  ].join('\n');

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, out, 'utf8');
  console.log(`wrote   ${OUTPUT}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
