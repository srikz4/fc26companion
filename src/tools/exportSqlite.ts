/**
 * Export a parsed save to a browsable SQLite database.
 *
 * This is an exploration tool, not part of the pipeline. It writes every table the
 * parser produced, one SQLite table each, so the whole save can be opened in
 * DB Browser and queried. Nothing here feeds the engine.
 *
 * Two additions beyond a straight dump, both to keep the file honest:
 *
 *   `_meta`             what was parsed, when, from which file, and the parser
 *                       version, so a stale export is recognisable as one.
 *   `_unknown_fields`   fields the meta XML could not name. They are exported as
 *                       `unk_<shortname>` columns with their raw values, so a new
 *                       FC 26 field can be identified by diffing two saves.
 *   `_name_fragments`   prefix-compressed names the parser refused to guess at.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ParseResult, FieldValue, Row } from '../parser/dbReader.ts';

export interface ExportOptions {
  outputPath: string;
  parsed: ParseResult;
  sourceFile: string;
  contentHash: string;
  parserVersion: string;
  /** Omit cosmetic face-morph tables, which are hundreds of useless columns. */
  skipCosmetic?: boolean;
}

/** Face/body morph tables: real data, but noise for career analysis. */
const COSMETIC_TABLES = new Set(['cp_skeletal', 'cp_flesh', 'cp_fat', 'outfitarrangements']);

/** SQLite identifiers are quoted, so any table or column name is safe to use. */
const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/**
 * Column set for a table. Rows in one table always share a field set, but scan a
 * sample rather than trusting the first row alone.
 */
function columnsOf(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const row of rows.slice(0, 50)) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

function bind(value: FieldValue): string | number | null {
  if (value === null || value === undefined) return null;
  return value;
}

export interface ExportSummary {
  tables: number;
  rows: number;
  skipped: string[];
  outputPath: string;
}

export function exportToSqlite(options: ExportOptions): ExportSummary {
  const { outputPath, parsed } = options;
  mkdirSync(dirname(outputPath), { recursive: true });

  const db = new Database(outputPath);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');

  const skipped: string[] = [];
  let tableCount = 0;
  let rowCount = 0;

  const write = db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS _meta;
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
      DROP TABLE IF EXISTS _unknown_fields;
      CREATE TABLE _unknown_fields (
        source_table TEXT, shortname TEXT, column_name TEXT, row_count INTEGER
      );
      DROP TABLE IF EXISTS _name_fragments;
      CREATE TABLE _name_fragments (
        source_table TEXT, field TEXT, row_index INTEGER, prefix_code INTEGER,
        prefix_code_hex TEXT, suffix TEXT
      );
    `);

    const meta = db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)');
    meta.run('source_file', options.sourceFile);
    meta.run('content_hash', options.contentHash);
    meta.run('parser_version', options.parserVersion);
    meta.run('exported_at', new Date().toISOString());
    meta.run('databases', String(parsed.databases.length));
    meta.run('unknown_tables', parsed.unknownTables.join(', ') || '(none)');

    for (const [name, rows] of Object.entries(parsed.tables)) {
      if (options.skipCosmetic !== false && COSMETIC_TABLES.has(name)) {
        skipped.push(name);
        continue;
      }
      if (rows.length === 0) continue;

      const columns = columnsOf(rows);
      if (columns.length === 0) continue;

      db.exec(`DROP TABLE IF EXISTS ${quote(name)}`);
      db.exec(`CREATE TABLE ${quote(name)} (${columns.map((c) => quote(c)).join(', ')})`);

      const insert = db.prepare(
        `INSERT INTO ${quote(name)} (${columns.map((c) => quote(c)).join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
      );
      for (const row of rows) {
        insert.run(columns.map((c) => bind(row[c] ?? null)));
        rowCount++;
      }
      tableCount++;

      // Index the obvious join keys so exploration is not painful.
      for (const key of ['playerid', 'teamid', 'leagueid', 'nameid']) {
        if (columns.includes(key)) {
          db.exec(`CREATE INDEX IF NOT EXISTS ${quote(`ix_${name}_${key}`)} ON ${quote(name)} (${quote(key)})`);
        }
      }
    }

    const unknown = db.prepare(
      'INSERT INTO _unknown_fields (source_table, shortname, column_name, row_count) VALUES (?, ?, ?, ?)',
    );
    for (const stat of parsed.stats) {
      for (const shortname of stat.unknownFields) {
        unknown.run(stat.table, shortname, `unk_${shortname}`, stat.rows);
      }
    }

    const fragment = db.prepare(
      `INSERT INTO _name_fragments (source_table, field, row_index, prefix_code, prefix_code_hex, suffix)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const n of parsed.incompleteNames) {
      fragment.run(n.table, n.field, n.row, n.prefixCode, `0x${n.prefixCode.toString(16).padStart(4, '0')}`, n.suffix);
    }
  });

  write();
  db.exec('VACUUM');
  db.close();

  return { tables: tableCount, rows: rowCount, skipped, outputPath };
}
