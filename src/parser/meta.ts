/**
 * FIFA NG DB schema metadata.
 *
 * The save stores four-character shortnames for tables and fields; the meta XML
 * maps those to readable names and carries the `rangelow` offset that bit-packed
 * integers are stored relative to.
 *
 * spec.md §1.3: the FC 25 meta XML resolves FC 26 fine — 52 of 53 table
 * shortnames, and unknown field shortnames only in `players` (8 of 145) and
 * `teams` (9 of 110). No FC 26-specific XML is needed.
 */
import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

export interface DbMeta {
  /** table shortname -> table name, e.g. "plyr" -> "players" */
  tableNames: Map<string, string>;
  /** field shortname -> field name, e.g. "ovrl" -> "overallrating" */
  fieldNames: Map<string, string>;
  /** `${tableName}${fieldName}` -> rangelow offset for integer fields */
  fieldRange: Map<string, number>;
  /** table name -> primary key field name */
  primaryKeys: Map<string, string>;
}

interface RawField {
  '@_name': string;
  '@_shortname': string;
  '@_type': string;
  '@_rangelow'?: string;
  '@_key'?: string;
}

interface RawTable {
  '@_name': string;
  '@_shortname': string;
  fields: { field: RawField | RawField[] };
}

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export function parseDbMeta(xmlText: string): DbMeta {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xmlText) as { database?: { table?: RawTable | RawTable[] } };

  const tables = asArray(doc.database?.table);
  if (tables.length === 0) throw new Error('meta XML contains no <table> elements');

  const meta: DbMeta = {
    tableNames: new Map(),
    fieldNames: new Map(),
    fieldRange: new Map(),
    primaryKeys: new Map(),
  };

  for (const table of tables) {
    const tableName = table['@_name'];
    meta.tableNames.set(table['@_shortname'], tableName);

    for (const field of asArray(table.fields?.field)) {
      const fieldName = field['@_name'];
      meta.fieldNames.set(field['@_shortname'], fieldName);

      const rangeLow =
        field['@_type'] === 'DBOFIELDTYPE_INTEGER' ? Number(field['@_rangelow'] ?? 0) : 0;
      meta.fieldRange.set(tableName + fieldName, Number.isFinite(rangeLow) ? rangeLow : 0);

      if (field['@_key'] === 'True') meta.primaryKeys.set(tableName, fieldName);
    }
  }

  return meta;
}

export function loadDbMeta(xmlPath: string): DbMeta {
  return parseDbMeta(readFileSync(xmlPath, 'utf8'));
}
