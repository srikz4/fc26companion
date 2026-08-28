/**
 * FBCHUNKS / `DB\0\x08` container reader for EA SPORTS FC save files.
 *
 * Ported from fc25/watcher/src/services/fc25/rawParser.js, which is correct about
 * the container and the bit packing. Three changes, all documented in spec.md §2.2:
 *
 *   1. Index-aligned field keys (spec.md §1.4). The FC 25 reader assigned decoded
 *      values positionally via `record[keys[Object.keys(record).length]]`, but built
 *      `keys` only from fields the meta XML knew. FC 26 added 8 fields to `players`
 *      and 9 to `teams`, so every field after the first unknown landed under the
 *      wrong name while the bit cursor stayed correct — which is why Bruno Fernandes
 *      read as `finishing: 100000`. Unknown fields are now named `unk_<shortname>`
 *      and hold their slot.
 *   2. Databases merge by concatenation, not assignment (spec.md §1.2).
 *   3. String fields decode through `nameCodec`, which is UTF-8-first and refuses
 *      to render EA’s prefix-compressed names as if they were whole (spec.md §2.2).
 */
import { BufferReader } from './bufferReader.ts';
import { decodeName } from './nameCodec.ts';
import type { DbMeta } from './meta.ts';

/** Container signature: "DB\0\x08\0\0\0\0" */
const DATABASE_HEADER = Buffer.from([0x44, 0x42, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);

/** Field type codes as stored in the table descriptor. */
const FIELD_STRING = 0;
const FIELD_INT = 3;
const FIELD_FLOAT = 4;

export type FieldValue = string | number | null;
export type Row = Record<string, FieldValue>;
export type Tables = Record<string, Row[]>;

export interface TableStats {
  table: string;
  rows: number;
  fields: number;
  recordSize: number;
  /** Shortnames present in the save but absent from the meta XML. */
  unknownFields: string[];
}

/**
 * A string field that used EA's prefix-dictionary form. The value is stored as an
 * empty string because the dictionary is not in the save; the code and suffix are
 * recorded here so the dictionary can be worked out later (spec.md §9 E-1).
 */
export interface IncompleteName {
  table: string;
  field: string;
  row: number;
  prefixCode: number;
  suffix: string;
}

/** Cap so a pathological save cannot balloon the result. */
const MAX_INCOMPLETE_NAMES = 1000;

export interface ParseResult {
  tables: Tables;
  /** One entry per `DB\0\x08` block, in file order. */
  databases: { index: number; tables: string[] }[];
  /** Table shortnames in the save that the meta XML could not name. */
  unknownTables: string[];
  stats: TableStats[];
  incompleteNames: IncompleteName[];
}

/** Split a save buffer into its constituent `DB\0\x08` blocks. */
export function unpackDatabases(save: Buffer): Buffer[] {
  const blocks: Buffer[] = [];
  let offset = save.indexOf(DATABASE_HEADER);

  while (offset >= 0) {
    const reader = new BufferReader(save, offset + DATABASE_HEADER.length);
    const size = reader.readUInt32LE();
    if (size <= 0 || offset + size > save.length) {
      throw new Error(`database at offset ${offset} declares invalid size ${size}`);
    }
    blocks.push(save.subarray(offset, offset + size));
    offset = save.indexOf(DATABASE_HEADER, offset + size);
  }

  return blocks;
}

interface FieldDescriptor {
  type: number;
  bitOffset: number;
  bitDepth: number;
  shortName: string;
  /** Meta-XML name, or `unk_<shortname>` when the meta XML does not know the field. */
  key: string;
  known: boolean;
}

/** Decode one `DB\0\x08` block into named tables. */
export function readDatabase(
  block: Buffer,
  meta: DbMeta,
  wanted?: ReadonlySet<string>,
): { tables: Tables; unknownTables: string[]; stats: TableStats[]; incompleteNames: IncompleteName[] } {
  const reader = new BufferReader(block, DATABASE_HEADER.length);

  const declaredSize = reader.readUInt32LE();
  if (declaredSize !== block.length) {
    throw new Error(`database size mismatch: header says ${declaredSize}, block is ${block.length}`);
  }

  reader.skip(4);
  const tableCount = reader.readUInt32LE();
  reader.skip(4);

  const shortNames: string[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < tableCount; i++) {
    shortNames.push(reader.readBytes(4).toString('latin1'));
    offsets.push(reader.readUInt32LE());
  }
  reader.skip(4);
  const tablesStart = reader.position;

  const tables: Tables = {};
  const unknownTables: string[] = [];
  const stats: TableStats[] = [];
  const incompleteNames: IncompleteName[] = [];

  for (let i = 0; i < tableCount; i++) {
    const shortName = shortNames[i]!;
    const tableName = meta.tableNames.get(shortName);
    if (tableName === undefined) {
      unknownTables.push(shortName);
      continue;
    }
    if (wanted && !wanted.has(tableName)) continue;

    reader.position = tablesStart + offsets[i]!;
    reader.skip(4);
    const recordSize = reader.readUInt32LE();
    reader.skip(10);
    const recordCount = reader.readUInt16LE();
    reader.skip(4);
    const fieldCount = reader.readUInt8();
    reader.skip(11);

    // Field descriptors are stored in declaration order; records are laid out in
    // ascending bit-offset order, so sort before decoding.
    const declared: FieldDescriptor[] = [];
    for (let f = 0; f < fieldCount; f++) {
      const type = reader.readUInt32LE();
      const bitOffset = reader.readUInt32LE();
      const shortField = reader.readBytes(4).toString('latin1');
      const bitDepth = reader.readUInt32LE();
      const known = meta.fieldNames.get(shortField);
      declared.push({
        type,
        bitOffset,
        bitDepth,
        shortName: shortField,
        key: known ?? `unk_${shortField}`,
        known: known !== undefined,
      });
    }
    const fields = declared.slice().sort((a, b) => a.bitOffset - b.bitOffset);

    stats.push({
      table: tableName,
      rows: recordCount,
      fields: fieldCount,
      recordSize,
      unknownFields: fields.filter((f) => !f.known).map((f) => f.shortName),
    });

    if (recordCount <= 0) {
      tables[tableName] = [];
      continue;
    }

    // Precompute rangelow per field. Unknown fields have no meta entry, so they
    // carry no offset — they are stored raw and never displayed (spec.md §2.3).
    const rangeLow = fields.map((f) =>
      f.known ? (meta.fieldRange.get(tableName + f.key) ?? 0) : 0,
    );

    const rows: Row[] = new Array(recordCount);
    for (let r = 0; r < recordCount; r++) {
      const row: Row = {};
      const recordStart = reader.position;

      // Bit-packed integers are read as a running stream; string and float fields
      // are byte-addressed and reset the bit cursor.
      let carry = 0;
      let carryBits = 0;

      for (let f = 0; f < fieldCount; f++) {
        const field = fields[f]!;
        let value: FieldValue;

        switch (field.type) {
          case FIELD_STRING: {
            carry = 0;
            carryBits = 0;
            reader.position = recordStart + (field.bitOffset >> 3);
            const decoded = decodeName(reader.readBytes(field.bitDepth >> 3));
            if (decoded.complete) {
              value = decoded.text;
            } else {
              // Prefix-compressed: the dictionary ships with the game, not the
              // save. Emit nothing rather than a suffix that reads like a name.
              value = '';
              if (incompleteNames.length < MAX_INCOMPLETE_NAMES) {
                incompleteNames.push({
                  table: tableName,
                  field: field.key,
                  row: r,
                  prefixCode: decoded.prefixCode ?? 0,
                  suffix: decoded.text,
                });
              }
            }
            break;
          }
          case FIELD_INT: {
            const depth = field.bitDepth;
            let raw = 0;
            let bit = 0;
            if (carryBits !== 0) {
              bit = 8 - carryBits;
              raw = carry >>> carryBits;
            }
            while (bit < depth) {
              carry = reader.readUInt8();
              // Multiply rather than `<<`: a 32-bit field shifted with `<<` wraps
              // into a negative int32. FC 26 has fields at that width.
              raw += carry * 2 ** bit;
              bit += 8;
            }
            carryBits = (depth + 8 - bit) & 7;
            raw %= 2 ** depth;
            value = raw + rangeLow[f]!;
            break;
          }
          case FIELD_FLOAT: {
            reader.position = recordStart + (field.bitOffset >> 3);
            value = reader.readUInt32LE();
            break;
          }
          default:
            value = null;
            break;
        }

        // The fix: index-aligned assignment. Unknown fields still consume their
        // slot, so every later field keeps its correct name.
        row[field.key] = value;
      }

      reader.position = recordStart + recordSize;
      rows[r] = row;
    }

    tables[tableName] = rows;
  }

  return { tables, unknownTables, stats, incompleteNames };
}

/** Parse a whole save file into named tables, merging across its databases. */
export function parseSave(save: Buffer, meta: DbMeta, wanted?: Iterable<string>): ParseResult {
  const want = wanted ? new Set(wanted) : undefined;
  const blocks = unpackDatabases(save);
  if (blocks.length === 0) throw new Error('no DB\\0\\x08 database found in save');

  const tables: Tables = {};
  const databases: ParseResult['databases'] = [];
  const unknownTables: string[] = [];
  const stats: TableStats[] = [];
  const incompleteNames: IncompleteName[] = [];

  blocks.forEach((block, index) => {
    const db = readDatabase(block, meta, want);
    databases.push({ index, tables: Object.keys(db.tables).sort() });
    unknownTables.push(...db.unknownTables);
    stats.push(...db.stats);
    incompleteNames.push(...db.incompleteNames);

    // Concatenate. Assigning would drop rows when a table name spans databases.
    for (const [name, rows] of Object.entries(db.tables)) {
      (tables[name] ??= []).push(...rows);
    }
  });

  return {
    tables,
    databases,
    unknownTables: [...new Set(unknownTables)],
    stats,
    incompleteNames,
  };
}
