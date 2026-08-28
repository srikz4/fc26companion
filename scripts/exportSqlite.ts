/**
 * Dump a save to a browsable SQLite database for DB Browser.
 *
 *   npm run export:sqlite                      # newest save -> exports/<name>.sqlite
 *   npm run export:sqlite -- <save> [out]      # a specific save
 *   npm run export:sqlite -- --all             # every save in the settings folder
 *   npm run export:sqlite -- --cosmetic        # include face-morph tables
 */
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave } from '../src/parser/dbReader.ts';
import { exportToSqlite } from '../src/tools/exportSqlite.ts';
import { hashSave, PARSER_VERSION } from '../src/store/store.ts';
import {
  findLatestManagerCareerSave,
  listManagerCareerSaves,
  resolveSaveDirectory,
} from '../src/core/saveLocation.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const META_PATH = join(root, 'data', 'fifa_ng_db-meta.xml');
const EXPORT_DIR = join(root, 'exports');

function exportOne(savePath: string, outPath: string, skipCosmetic: boolean): void {
  const meta = loadDbMeta(META_PATH);
  const bytes = readFileSync(savePath);

  const startedAt = performance.now();
  const parsed = parseSave(bytes, meta);
  const parseMs = Math.round(performance.now() - startedAt);

  const summary = exportToSqlite({
    outputPath: outPath,
    parsed,
    sourceFile: savePath,
    contentHash: hashSave(bytes),
    parserVersion: PARSER_VERSION,
    skipCosmetic,
  });

  console.log(`  ${basename(savePath)}  parsed ${parseMs} ms`);
  console.log(
    `  -> ${summary.outputPath}\n     ${summary.tables} tables, ${summary.rows.toLocaleString('en-GB')} rows` +
      (summary.skipped.length ? `, skipped cosmetic: ${summary.skipped.join(', ')}` : ''),
  );
  if (parsed.incompleteNames.length) {
    console.log(`     ${parsed.incompleteNames.length} prefix-compressed names in _name_fragments`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const skipCosmetic = !args.includes('--cosmetic');
  const all = args.includes('--all');
  const positional = args.filter((a) => !a.startsWith('--'));

  if (all) {
    const dir = resolveSaveDirectory();
    if (!dir) {
      console.error('No FC 26 settings directory found.');
      process.exit(1);
    }
    const saves = listManagerCareerSaves(dir);
    console.log(`exporting ${saves.length} save(s) from ${dir}\n`);
    for (const save of saves) {
      exportOne(save.path, join(EXPORT_DIR, `${save.fileName}.sqlite`), skipCosmetic);
    }
    return;
  }

  const explicit = positional[0];
  const save = explicit
    ? { path: resolve(explicit), fileName: basename(explicit) }
    : findLatestManagerCareerSave();

  if (!save) {
    console.error('No CmMgrC* Manager Career save found. Pass a path explicitly.');
    process.exit(1);
  }

  const out = positional[1] ? resolve(positional[1]) : join(EXPORT_DIR, `${save.fileName}.sqlite`);
  exportOne(save.path, out, skipCosmetic);
  console.log('\nOpen it in DB Browser for SQLite (or SQLCipher — the file is plain SQLite).');
}

main();
