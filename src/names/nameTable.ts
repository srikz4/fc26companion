/**
 * Player name resolution.
 *
 * The save identifies players by `playerid` and stores names as `nameid`
 * references into a table that ships with the game, not with the save. FC 26
 * re-sorted that id space, so FC 25's table is not a substitute — it resolves
 * every id to a confident wrong name (spec.md §2.5).
 *
 * Resolution order, most trustworthy first:
 *
 *   1. `editedplayernames` — literal strings in the save itself. Used only when
 *      `nameCodec` decoded them completely; a prefix-compressed first name is
 *      dropped rather than guessed.
 *   2. An imported `playerid -> name` table, if one has been installed.
 *   3. `dcplayernames` — a literal nameid -> string table carried in the save.
 *   4. The derived nameid table (see deriveNameTable.ts). Marked provisional:
 *      measured at 98.7% precision on surnames, so ~1 in 75 is wrong.
 *   5. `#<playerid>`.
 *
 * There is deliberately no sixth step. An unresolved player renders as an id with
 * jersey, position and attributes intact.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Row, Tables } from '../parser/dbReader.ts';
import { deriveName, EMPTY_DERIVED, type DerivedNameIds } from './deriveNameTable.ts';

export interface NameEntry {
  /** Short display form, e.g. "B. Mbeumo". */
  short: string;
  /** Full form, e.g. "Bryan Tetsadong Marceau Mbeumo". */
  full: string;
}

export interface NameTable {
  /** playerid -> name. Empty when no table has been imported. */
  byPlayerId: Map<number, NameEntry>;
  source: string | null;
  importedAt: string | null;
}

export const EMPTY_NAME_TABLE: NameTable = {
  byPlayerId: new Map(),
  source: null,
  importedAt: null,
};

/** Minimal RFC 4180 reader: handles quoted fields, embedded commas and doubled quotes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

/**
 * Names occasionally arrive with a second script concatenated onto the Latin form
 * (observed: "Noussair Mazraouiنصير مزراوي"). Cut at the first character outside
 * Latin/punctuation rather than shipping the artefact.
 */
const NON_LATIN = /[^\p{Script=Latin}\p{M}\p{N}\s'.\-]/u;

export function sanitiseName(raw: string): string {
  const trimmed = raw.trim();
  const cut = NON_LATIN.exec(trimmed);
  return (cut ? trimmed.slice(0, cut.index) : trimmed).trim();
}

/**
 * Load a name table from CSV. Requires a `player_id` column and at least one of
 * `short_name` / `long_name`. Rows missing either are skipped, not defaulted.
 */
export function parseNameTable(csv: string, source: string): NameTable {
  const lines = csv.split(/\r?\n/);

  // Our own exports carry `#` provenance lines above the header.
  const headerAt = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('#'));
  if (headerAt === -1) throw new Error(`${source}: file is empty`);
  const header = parseCsvLine(lines[headerAt] ?? '').map((h) => h.trim().replace(/^﻿/, ''));

  const idCol = header.indexOf('player_id');
  const shortCol = header.indexOf('short_name');
  const longCol = header.indexOf('long_name');

  if (idCol === -1) throw new Error(`${source}: no 'player_id' column (found: ${header.slice(0, 8).join(', ')})`);
  if (shortCol === -1 && longCol === -1) {
    throw new Error(`${source}: needs a 'short_name' or 'long_name' column`);
  }

  const byPlayerId = new Map<number, NameEntry>();
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) continue;
    const cells = parseCsvLine(line);

    const id = Number(cells[idCol]);
    if (!Number.isInteger(id) || id <= 0) continue;

    const short = sanitiseName(shortCol === -1 ? '' : (cells[shortCol] ?? ''));
    const full = sanitiseName(longCol === -1 ? '' : (cells[longCol] ?? ''));
    if (!short && !full) continue;

    // First row wins: a table may carry several title versions of one player.
    if (!byPlayerId.has(id)) byPlayerId.set(id, { short: short || full, full: full || short });
  }

  return { byPlayerId, source, importedAt: new Date().toISOString() };
}

export function loadNameTable(path: string): NameTable {
  if (!existsSync(path)) return EMPTY_NAME_TABLE;
  return parseNameTable(readFileSync(path, 'utf8'), path);
}

export type NameOrigin = 'edited' | 'imported' | 'literal' | 'derived' | 'unresolved';

export interface ResolvedName {
  /** What to show. Always safe to render. */
  display: string;
  full: string;
  origin: NameOrigin;
  /**
   * True when the name was derived rather than read (spec.md §2.3). The UI marks
   * these; ~1.3% of derived surnames are wrong. Never drives a recommendation.
   */
  provisional: boolean;
}

/** Names the game wrote into the save itself, keyed by playerid. */
export function editedNameIndex(tables: Tables): Map<number, ResolvedName> {
  const index = new Map<number, ResolvedName>();

  for (const row of tables['editedplayernames'] ?? []) {
    const id = row['playerid'];
    if (typeof id !== 'number') continue;

    const first = typeof row['firstname'] === 'string' ? row['firstname'] : '';
    const surname = typeof row['surname'] === 'string' ? row['surname'] : '';
    const common = typeof row['commonname'] === 'string' ? row['commonname'] : '';

    // A prefix-compressed field decoded to '' upstream. Use whatever is whole:
    // a surname alone is honest, a mangled first name is not.
    const display = common || [first, surname].filter(Boolean).join(' ');
    if (!display) continue;

    index.set(id, { display, full: display, origin: 'edited', provisional: false });
  }

  return index;
}

export interface NameResolver {
  resolve(playerId: number): ResolvedName;
  /** How many of the given ids resolved to a real name. */
  coverage(playerIds: Iterable<number>): { resolved: number; total: number };
}

export function createNameResolver(
  tables: Tables,
  table: NameTable = EMPTY_NAME_TABLE,
  derived: DerivedNameIds = EMPTY_DERIVED,
): NameResolver {
  const edited = editedNameIndex(tables);
  const players = new Map<number, Row>();
  for (const player of tables['players'] ?? []) {
    const id = player['playerid'];
    if (typeof id === 'number') players.set(id, player);
  }

  const cache = new Map<number, ResolvedName>();

  const compute = (playerId: number): ResolvedName => {
    // 1. Strings the save spells out itself. An override, so it wins outright.
    const fromSave = edited.get(playerId);
    if (fromSave) return fromSave;

    // 2. The imported playerid table: real names for real players.
    const imported = table.byPlayerId.get(playerId);
    if (imported) {
      return { display: imported.short, full: imported.full, origin: 'imported', provisional: false };
    }

    // 3. Derivation, for newgens and anyone the imported table misses. A name
    //    assembled only from dcplayernames is read, not derived, so it is not
    //    marked provisional (spec.md §2.5a).
    const player = players.get(playerId);
    if (player) {
      const guess = deriveName(player, derived);
      if (guess) {
        // A first name alone keeps the id beside it — half a name is not a name.
        const display = guess.partial ? `${guess.display} #${playerId}` : guess.display;
        return {
          display,
          full: display,
          origin: guess.literalOnly ? 'literal' : 'derived',
          provisional: !guess.literalOnly,
        };
      }
    }

    return { display: `#${playerId}`, full: `#${playerId}`, origin: 'unresolved', provisional: false };
  };

  const resolve = (playerId: number): ResolvedName => {
    const hit = cache.get(playerId);
    if (hit) return hit;
    const value = compute(playerId);
    cache.set(playerId, value);
    return value;
  };

  return {
    resolve,
    coverage(playerIds) {
      let resolved = 0;
      let total = 0;
      for (const id of playerIds) {
        total++;
        if (resolve(id).origin !== 'unresolved') resolved++;
      }
      return { resolved, total };
    },
  };
}

/** Convenience for callers that only have rows. */
export function playerIdsOf(rows: Row[]): number[] {
  return rows
    .map((r) => r['playerid'])
    .filter((v): v is number => typeof v === 'number');
}
