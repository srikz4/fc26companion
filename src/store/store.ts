/**
 * The append-only store (spec.md §2.4).
 *
 * `ingest` is idempotent: the same save bytes ingested twice produce one
 * snapshot. That matters because the game rewrites the save in several passes,
 * and because re-running a backfill must not double history.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA, SCHEMA_VERSION } from './schema.ts';
import {
  PLAYER_OBSERVED_FIELDS,
  LINK_OBSERVED_FIELDS,
  CONTRACT_OBSERVED_FIELDS,
} from './schema.ts';
import type { ParseResult, Row, Tables } from '../parser/dbReader.ts';
import type { SlotAnchor } from '../engine/standings.ts';
import type { Pairing } from '../engine/pairings.ts';

export const PARSER_VERSION = '0.1.0';

/** One thing that happened, on its way into the ledger. */
export interface StoryEventInput {
  careerId: number;
  key: string;
  kind: string;
  season?: number | null;
  title: string;
  detail?: string | null;
  gameDate?: number | null;
  snapshotId: number;
  observedAt?: string;
}

/** One thing that happened, as the ledger keeps it. */
export interface StoryEvent {
  key: string;
  kind: string;
  season: number | null;
  title: string;
  detail: string | null;
  gameDate: number | null;
  observedAt: string;
}

export interface CareerIdentity {
  clubTeamId: number;
  clubName: string | null;
  managerName: string | null;
  identityKey: string;
}

export interface IngestInput {
  parsed: ParseResult;
  contentHash: string;
  sourceFile: string;
  sourceStamp?: string | null;
  copiedTo?: string | null;
  sizeBytes: number;
  parseMs?: number;
  /** Wall-clock time of ingest. Only ever used for "synced N seconds ago". */
  observedAt?: string;
}

export interface IngestResult {
  careerId: number;
  snapshotId: number;
  /** True when this exact save had already been ingested; nothing was written. */
  duplicate: boolean;
  observations: number;
  entities: number;
  identity: CareerIdentity;
  gameDate: number | null;
  gameDateBasis: string | null;
}

const num = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === 'number' ? (row[key] as number) : null;
const text = (row: Row | undefined, key: string): string | null => {
  const v = row?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
};
const rowsOf = (t: Tables, name: string): Row[] => t[name] ?? [];

export function hashSave(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Career identity (spec.md §2.1). Club plus manager name; two saves that disagree
 * on either are different careers and are never merged.
 */
export function readCareerIdentity(tables: Tables): CareerIdentity {
  const user = rowsOf(tables, 'career_users')[0];
  const info = rowsOf(tables, 'career_managerinfo')[0];

  const clubTeamId = num(info, 'clubteamid') ?? num(user, 'clubteamid');
  if (clubTeamId === null) throw new Error('save has no club: career_managerinfo/career_users empty');

  const club = rowsOf(tables, 'teams').find((t) => num(t, 'teamid') === clubTeamId);
  const managerName =
    [text(user, 'firstname'), text(user, 'surname')].filter(Boolean).join(' ') || null;

  return {
    clubTeamId,
    clubName: text(club, 'teamname'),
    managerName,
    identityKey: `${clubTeamId}:${managerName ?? 'unknown'}`,
  };
}

/**
 * Estimate the in-game date (spec.md §9 D-1).
 *
 * `career_calendar.currdate` reads 20080101 in every FC 25 and FC 26 save — a
 * static template. The latest dated row in the save is a lower bound on "now",
 * and the basis is returned alongside so the UI can label it an estimate. It is
 * never presented as a read value.
 */
export function estimateGameDate(tables: Tables): { date: number | null; basis: string | null } {
  const sources: [string, string][] = [
    ['persistent_events', 'eventdate'],
    ['career_playermatchratinghistory', 'date'],
    ['career_presignedcontract', 'signeddate'],
    ['career_playercontract', 'last_status_change_date'],
  ];

  let best: number | null = null;
  let basis: string | null = null;

  for (const [table, field] of sources) {
    for (const row of rowsOf(tables, table)) {
      const value = num(row, field);
      // Guard against sentinel dates; a career runs from 2024 onward.
      if (value === null || value < 20240101 || value > 20500101) continue;
      if (best === null || value > best) {
        best = value;
        basis = `${table}.${field}`;
      }
    }
  }

  return { date: best, basis };
}

export class HistoryStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
    this.db
      .prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  /** The underlying handle, for the tag store (spec.md §2.4 keeps one file). */
  get handle(): Database.Database {
    return this.db;
  }

  /** Has this exact save already been stored for this career? */
  hasSnapshot(identityKey: string, contentHash: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM snapshot s JOIN career c USING (career_id)
         WHERE c.identity_key = ? AND s.content_hash = ? LIMIT 1`,
      )
      .get(identityKey, contentHash);
    return row !== undefined;
  }

  ingest(input: IngestInput): IngestResult {
    const tables = input.parsed.tables;
    const identity = readCareerIdentity(tables);
    const observedAt = input.observedAt ?? new Date().toISOString();
    const { date: gameDate, basis: gameDateBasis } = estimateGameDate(tables);

    const run = this.db.transaction((): IngestResult => {
      // Career.
      this.db
        .prepare(
          `INSERT INTO career (club_team_id, club_name, manager_name, identity_key, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(identity_key) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             club_name = COALESCE(excluded.club_name, career.club_name)`,
        )
        .run(
          identity.clubTeamId,
          identity.clubName,
          identity.managerName,
          identity.identityKey,
          observedAt,
          observedAt,
        );

      const careerId = (
        this.db.prepare('SELECT career_id FROM career WHERE identity_key = ?').get(identity.identityKey) as
          | { career_id: number }
          | undefined
      )!.career_id;

      // Snapshot. A duplicate is a no-op, not an error: the game writes the same
      // bytes more than once and a backfill may be re-run.
      const existing = this.db
        .prepare('SELECT snapshot_id FROM snapshot WHERE career_id = ? AND content_hash = ?')
        .get(careerId, input.contentHash) as { snapshot_id: number } | undefined;

      if (existing) {
        return {
          careerId,
          snapshotId: existing.snapshot_id,
          duplicate: true,
          observations: 0,
          entities: 0,
          identity,
          gameDate,
          gameDateBasis,
        };
      }

      const season = num(rowsOf(tables, 'career_users')[0], 'seasoncount');
      const snapshotId = Number(
        this.db
          .prepare(
            `INSERT INTO snapshot (career_id, content_hash, source_file, source_stamp, copied_to,
                                   size_bytes, game_date, game_date_basis, season, observed_at,
                                   parse_ms, parser_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            careerId,
            input.contentHash,
            input.sourceFile,
            input.sourceStamp ?? null,
            input.copiedTo ?? null,
            input.sizeBytes,
            gameDate,
            gameDateBasis,
            season,
            observedAt,
            input.parseMs ?? null,
            PARSER_VERSION,
          ).lastInsertRowid,
      );

      const counts = this.writeObservations(careerId, snapshotId, tables);
      this.writeNameFragments(snapshotId, input.parsed);
      this.markDeparted(careerId, snapshotId);

      return {
        careerId,
        snapshotId,
        duplicate: false,
        observations: counts.observations,
        entities: counts.entities,
        identity,
        gameDate,
        gameDateBasis,
      };
    });

    return run();
  }

  private writeObservations(
    careerId: number,
    snapshotId: number,
    tables: Tables,
  ): { observations: number; entities: number } {
    const upsertEntity = this.db.prepare(
      `INSERT INTO entity (career_id, kind, game_id, first_snapshot, last_snapshot)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(career_id, kind, game_id) DO UPDATE SET
         last_snapshot = excluded.last_snapshot,
         departed_at = NULL`,
    );
    const selectEntity = this.db.prepare(
      'SELECT entity_id FROM entity WHERE career_id = ? AND kind = ? AND game_id = ?',
    );
    const insertObservation = this.db.prepare(
      `INSERT INTO observation (entity_id, snapshot_id, field, value_num, value_text)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, field, snapshot_id) DO NOTHING`,
    );

    const entityIds = new Map<number, number>();
    const entityIdFor = (gameId: number): number => {
      const cached = entityIds.get(gameId);
      if (cached !== undefined) return cached;
      upsertEntity.run(careerId, 'player', gameId, snapshotId, snapshotId);
      const id = (selectEntity.get(careerId, 'player', gameId) as { entity_id: number }).entity_id;
      entityIds.set(gameId, id);
      return id;
    };

    let observations = 0;
    const observe = (entityId: number, field: string, value: number | string | null): void => {
      if (value === null || value === '') return;
      insertObservation.run(
        entityId,
        snapshotId,
        field,
        typeof value === 'number' ? value : null,
        typeof value === 'string' ? value : null,
      );
      observations++;
    };

    // Only the user's own squad is tracked over time. Storing 21,634 players per
    // snapshot would grow the store by ~1.2M rows per save for data no view reads.
    const identity = readCareerIdentity(tables);
    const squad = rowsOf(tables, 'teamplayerlinks').filter(
      (l) => num(l, 'teamid') === identity.clubTeamId,
    );
    const youth = rowsOf(tables, 'career_youthplayers');
    const trackedIds = new Set<number>();
    for (const link of squad) {
      const id = num(link, 'playerid');
      if (id !== null) trackedIds.add(id);
    }
    for (const y of youth) {
      const id = num(y, 'playerid');
      if (id !== null) trackedIds.add(id);
    }

    const playersById = new Map<number, Row>();
    for (const p of rowsOf(tables, 'players')) {
      const id = num(p, 'playerid');
      if (id !== null && trackedIds.has(id)) playersById.set(id, p);
    }
    const linksById = new Map(squad.map((l) => [num(l, 'playerid'), l]));
    const contractsById = new Map(
      rowsOf(tables, 'career_playercontract').map((c) => [num(c, 'playerid'), c]),
    );
    const youthById = new Map(youth.map((y) => [num(y, 'playerid'), y]));

    for (const gameId of trackedIds) {
      const player = playersById.get(gameId);
      if (!player) continue;
      const entityId = entityIdFor(gameId);

      for (const field of PLAYER_OBSERVED_FIELDS) observe(entityId, field, player[field] ?? null);

      const link = linksById.get(gameId);
      if (link) for (const field of LINK_OBSERVED_FIELDS) observe(entityId, `link.${field}`, link[field] ?? null);

      const contract = contractsById.get(gameId);
      if (contract) {
        for (const field of CONTRACT_OBSERVED_FIELDS) observe(entityId, `contract.${field}`, contract[field] ?? null);
      }

      const y = youthById.get(gameId);
      if (y) {
        observe(entityId, 'youth.swinglowpotential', y['swinglowpotential'] ?? null);
        observe(entityId, 'youth.potentialvariance', y['potentialvariance'] ?? null);
        observe(entityId, 'youth.monthsinsquad', y['monthsinsquad'] ?? null);
        observe(entityId, 'youth.playertier', y['playertier'] ?? null);
      }
    }

    return { observations, entities: entityIds.size };
  }

  private writeNameFragments(snapshotId: number, parsed: ParseResult): void {
    if (parsed.incompleteNames.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO name_fragment (snapshot_id, source_table, field, row_index, prefix_code, suffix)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    for (const n of parsed.incompleteNames) {
      insert.run(snapshotId, n.table, n.field, n.row, n.prefixCode, n.suffix);
    }
  }

  /** A tracked player absent from this snapshot has left the club. Kept, marked. */
  private markDeparted(careerId: number, snapshotId: number): void {
    this.db
      .prepare(
        `UPDATE entity SET departed_at = ?
         WHERE career_id = ? AND last_snapshot < ? AND departed_at IS NULL`,
      )
      .run(snapshotId, careerId, snapshotId);
  }

  /** Series for one field of one player, oldest first. Gaps stay gaps. */
  /**
   * Write an event once. A later save that re-derives the same event collides
   * on `key` and changes nothing — the first sighting keeps its date, which is
   * the whole point of a ledger.
   */
  recordStory(events: StoryEventInput[]): number {
    if (events.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO story_event
         (career_id, key, kind, season, title, detail, game_date, snapshot_id, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let written = 0;
    const run = this.db.transaction((list: StoryEventInput[]) => {
      for (const e of list) {
        const info = insert.run(
          e.careerId,
          e.key,
          e.kind,
          e.season ?? null,
          e.title,
          e.detail ?? null,
          e.gameDate ?? null,
          e.snapshotId,
          e.observedAt ?? new Date().toISOString(),
        );
        written += info.changes;
      }
    });
    run(events);
    return written;
  }

  /**
   * Correct how an already-recorded event is *classified* without touching when
   * it was seen.
   *
   * The ledger is append-only about facts: `game_date` and `observed_at` are
   * the record of when something happened and when we first saw it, and those
   * never move. But which season a record scoreline belongs to is a derivation,
   * and a derivation can be wrong — the first version filed every club record
   * under the current season instead of the season the match was played in.
   * Fixing the code has to fix the shelf the event sits on, or the ledger
   * preserves the bug forever.
   */
  reclassifyStory(events: StoryEventInput[]): number {
    if (events.length === 0) return 0;
    const update = this.db.prepare(
      `UPDATE story_event SET season = ?, title = ?, detail = ?
        WHERE career_id = ? AND key = ? AND (season IS NOT ? OR title IS NOT ? OR detail IS NOT ?)`,
    );
    let changed = 0;
    const run = this.db.transaction((list: StoryEventInput[]) => {
      for (const e of list) {
        changed += update.run(
          e.season ?? null,
          e.title,
          e.detail ?? null,
          e.careerId,
          e.key,
          e.season ?? null,
          e.title,
          e.detail ?? null,
        ).changes;
      }
    });
    run(events);
    return changed;
  }

  /**
   * Remember which club a fixture slot belongs to.
   *
   * Write-once per slot: the first result that names it is the naming, and a
   * later save re-deriving the same link changes nothing. If a slot ever
   * resolved to two different clubs the second reading is dropped rather than
   * allowed to overwrite, because one of the two is wrong and the older one at
   * least has a match date behind it.
   */
  recordSlotNames(careerId: number, season: number, anchors: SlotAnchor[]): number {
    if (anchors.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO fixture_slot
         (career_id, season, comp, slot, team_id, named_on, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let written = 0;
    const now = new Date().toISOString();
    const run = this.db.transaction((list: SlotAnchor[]) => {
      for (const a of list) {
        written += insert.run(careerId, season, a.comp, a.slot, a.teamId, a.namedOn ?? null, now).changes;
      }
    });
    run(anchors);
    return written;
  }

  /**
   * Remember who played whom in a round.
   *
   * Pairs are stored with the lower team id first so the same match observed
   * from two different saves collides instead of duplicating.
   */
  recordPairings(careerId: number, season: number, leagueId: number, pairings: Pairing[]): number {
    if (pairings.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO round_pairing
         (career_id, season, league_id, round_date, team_a, team_b, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let written = 0;
    const now = new Date().toISOString();
    const run = this.db.transaction((list: Pairing[]) => {
      for (const p of list) {
        const [a, b] = p.teamA <= p.teamB ? [p.teamA, p.teamB] : [p.teamB, p.teamA];
        written += insert.run(careerId, season, leagueId, p.date, a, b, now).changes;
      }
    });
    run(pairings);
    return written;
  }

  /**
   * Forget every slot name and pairing for a season.
   *
   * These rows are worked out from saves, not read from them, so they can
   * always be worked out again -- and must be, whenever the reasoning behind
   * them changes. Observations elsewhere in the store are never touched.
   */
  forgetFixtureLearning(careerId: number, season: number): number {
    const a = this.db.prepare('DELETE FROM fixture_slot WHERE career_id = ? AND season = ?').run(careerId, season);
    const b = this.db.prepare('DELETE FROM round_pairing WHERE career_id = ? AND season = ?').run(careerId, season);
    return a.changes + b.changes;
  }

  /** Every pairing seen this season, for one league. */
  pairings(careerId: number, season: number, leagueId: number): Pairing[] {
    return this.db
      .prepare(
        `SELECT round_date AS date, team_a AS teamA, team_b AS teamB
           FROM round_pairing WHERE career_id = ? AND season = ? AND league_id = ?`,
      )
      .all(careerId, season, leagueId) as Pairing[];
  }

  /** How many saves have been ingested, across every career. */
  snapshotCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number };
    return row.n;
  }

  /** Every slot named so far this season. */
  slotNames(careerId: number, season: number): SlotAnchor[] {
    return this.db
      .prepare(
        `SELECT comp, slot, team_id AS teamId, named_on AS namedOn
           FROM fixture_slot WHERE career_id = ? AND season = ?`,
      )
      .all(careerId, season) as SlotAnchor[];
  }

  /** The ledger for a career, newest first. */
  story(careerId: number): StoryEvent[] {
    return this.db
      .prepare(
        `SELECT key, kind, season, title, detail, game_date AS gameDate, observed_at AS observedAt
           FROM story_event WHERE career_id = ?
          ORDER BY COALESCE(game_date, 0) DESC, event_id DESC`,
      )
      .all(careerId) as StoryEvent[];
  }

  /** The newest snapshot id for a career, for stamping ledger entries. */
  latestSnapshot(careerId: number): number | null {
    const row = this.db
      .prepare('SELECT snapshot_id AS id FROM snapshot WHERE career_id = ? ORDER BY snapshot_id DESC LIMIT 1')
      .get(careerId) as { id: number } | undefined;
    return row?.id ?? null;
  }

  series(careerId: number, gameId: number, field: string): { snapshotId: number; gameDate: number | null; value: number | null }[] {
    return this.db
      .prepare(
        `SELECT o.snapshot_id AS snapshotId, s.game_date AS gameDate, o.value_num AS value
         FROM observation o
         JOIN entity e USING (entity_id)
         JOIN snapshot s ON s.snapshot_id = o.snapshot_id
         WHERE e.career_id = ? AND e.game_id = ? AND o.field = ?
         ORDER BY s.observed_at ASC`,
      )
      .all(careerId, gameId, field) as { snapshotId: number; gameDate: number | null; value: number | null }[];
  }

  snapshots(careerId: number): { snapshotId: number; gameDate: number | null; observedAt: string; season: number | null }[] {
    return this.db
      .prepare(
        `SELECT snapshot_id AS snapshotId, game_date AS gameDate, observed_at AS observedAt, season
         FROM snapshot WHERE career_id = ? ORDER BY observed_at ASC`,
      )
      .all(careerId) as { snapshotId: number; gameDate: number | null; observedAt: string; season: number | null }[];
  }

  careers(): { careerId: number; clubName: string | null; managerName: string | null; snapshots: number }[] {
    return this.db
      .prepare(
        `SELECT c.career_id AS careerId, c.club_name AS clubName, c.manager_name AS managerName,
                COUNT(s.snapshot_id) AS snapshots
         FROM career c LEFT JOIN snapshot s USING (career_id)
         GROUP BY c.career_id ORDER BY c.last_seen_at DESC`,
      )
      .all() as { careerId: number; clubName: string | null; managerName: string | null; snapshots: number }[];
  }
}
