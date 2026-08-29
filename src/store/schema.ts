/**
 * Append-only history store (spec.md §2.4).
 *
 * The observation table is the only fact in the system: one field value at one
 * snapshot. Everything else is either provenance (snapshot, career, entity) or
 * derived and disposable. Nothing here is ever updated in place — a player's
 * rating changing means a new observation row, never an edit to an old one.
 *
 * That is what makes history possible at all: the game shows today, and this
 * shows that potential moved.
 */

export const SCHEMA_VERSION = 3;

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- One career per save lineage. Identity is the club plus the manager's name plus
-- the save slot; two careers are never merged (spec.md §2.1).
CREATE TABLE IF NOT EXISTS career (
  career_id     INTEGER PRIMARY KEY,
  club_team_id  INTEGER NOT NULL,
  club_name     TEXT,
  manager_name  TEXT,
  identity_key  TEXT NOT NULL UNIQUE,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- One parsed save. Immutable. content_hash makes a rewrite of identical bytes
-- a no-op rather than a duplicate snapshot.
CREATE TABLE IF NOT EXISTS snapshot (
  snapshot_id     INTEGER PRIMARY KEY,
  career_id       INTEGER NOT NULL REFERENCES career(career_id),
  content_hash    TEXT NOT NULL,
  source_file     TEXT NOT NULL,
  source_stamp    TEXT,
  copied_to       TEXT,
  size_bytes      INTEGER NOT NULL,
  -- In-game date is derived, not read: career_calendar.currdate is a dead
  -- template in FC 26 (spec.md §9 D-1). Stored with its basis so the estimate is
  -- never mistaken for a fact.
  game_date       INTEGER,
  game_date_basis TEXT,
  season          INTEGER,
  observed_at     TEXT NOT NULL,
  parse_ms        INTEGER,
  parser_version  TEXT NOT NULL,
  UNIQUE (career_id, content_hash)
);

-- A thing we track over time. Departed players are kept and marked, never deleted
-- (spec.md §2.4).
CREATE TABLE IF NOT EXISTS entity (
  entity_id      INTEGER PRIMARY KEY,
  career_id      INTEGER NOT NULL REFERENCES career(career_id),
  kind           TEXT NOT NULL,
  game_id        INTEGER NOT NULL,
  first_snapshot INTEGER NOT NULL REFERENCES snapshot(snapshot_id),
  last_snapshot  INTEGER NOT NULL REFERENCES snapshot(snapshot_id),
  departed_at    INTEGER REFERENCES snapshot(snapshot_id),
  UNIQUE (career_id, kind, game_id)
);

-- The only fact. One row per (entity, field, snapshot).
CREATE TABLE IF NOT EXISTS observation (
  entity_id    INTEGER NOT NULL REFERENCES entity(entity_id),
  snapshot_id  INTEGER NOT NULL REFERENCES snapshot(snapshot_id),
  field        TEXT NOT NULL,
  value_num    REAL,
  value_text   TEXT,
  PRIMARY KEY (entity_id, field, snapshot_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS observation_by_snapshot ON observation (snapshot_id, field);

-- The story ledger (spec.md §15).
--
-- Observations say what a value IS at a snapshot; the ledger says what HAPPENED
-- and when we first saw it. A trophy, a record scoreline, a promotion out of the
-- academy: each is written once, keyed so a re-parse of the same save cannot
-- duplicate it, and never rewritten afterwards. That is what lets the Chronicle
-- say "in November" instead of recomputing the present and calling it history.
--
-- game_date is the estimated in-game date at first sighting, so an event is
-- dated by when it entered the save, not by when the file was read.
CREATE TABLE IF NOT EXISTS story_event (
  event_id    INTEGER PRIMARY KEY,
  career_id   INTEGER NOT NULL REFERENCES career(career_id),
  -- Stable identity for the thing that happened; the same event re-derived from
  -- a later save collides on this and is ignored.
  key         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  season      INTEGER,
  title       TEXT NOT NULL,
  detail      TEXT,
  game_date   INTEGER,
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(snapshot_id),
  observed_at TEXT NOT NULL,
  UNIQUE (career_id, key)
);
CREATE INDEX IF NOT EXISTS story_by_career ON story_event (career_id, season);
CREATE INDEX IF NOT EXISTS entity_by_career ON entity (career_id, kind);

-- Which club sits in which fixture slot (parser/fixtures.ts).
--
-- The save's calendar names its participants by slot, and keeps no map from a
-- slot to a club; only the post-matchday round-up puts real club ids next to a
-- scoreline, and it covers one round. So the map is learned a few slots at a
-- time and remembered here, and a table that starts mostly anonymous fills in
-- over a season. Every row was read from a result, never inferred: named_on is
-- the match date that proved it.
--
-- Slots are reshuffled when a new season regenerates the fixture list, so the
-- season is part of the key.
CREATE TABLE IF NOT EXISTS fixture_slot (
  career_id   INTEGER NOT NULL REFERENCES career(career_id),
  season      INTEGER NOT NULL,
  comp        INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  team_id     INTEGER NOT NULL,
  named_on    INTEGER,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (career_id, season, comp, slot)
) WITHOUT ROWID;

-- Prefix-compressed name fields we could not decode, kept so the dictionary can
-- be reconstructed later (spec.md §9 E-1). Diagnostic only; never displayed.
CREATE TABLE IF NOT EXISTS name_fragment (
  snapshot_id  INTEGER NOT NULL REFERENCES snapshot(snapshot_id),
  source_table TEXT NOT NULL,
  field        TEXT NOT NULL,
  row_index    INTEGER NOT NULL,
  prefix_code  INTEGER NOT NULL,
  suffix       TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, source_table, field, row_index)
) WITHOUT ROWID;
`;

/**
 * Fields lifted from each parsed save into observations.
 *
 * Deliberately a short list. Every field here is one the engine reads or the
 * views show; adding a field is a decision, not a side effect of it existing in
 * the save. `unk_*` fields are never observed.
 */
export const PLAYER_OBSERVED_FIELDS = [
  'overallrating',
  'potential',
  'birthdate',
  'preferredposition1',
  'preferredposition2',
  'preferredposition3',
  'preferredposition4',
  'preferredfoot',
  'skillmoves',
  'weakfootabilitytypecode',
  'height',
  'weight',
  'nationality',
  'isretiring',
  'contractvaliduntil',
  'emotion',
  'internationalrep',
  'playerjointeamdate',
  'role1',
  'role2',
  'role3',
  'trait1',
  'trait2',
  // Attributes, six groups.
  'acceleration',
  'sprintspeed',
  'agility',
  'balance',
  'reactions',
  'ballcontrol',
  'dribbling',
  'positioning',
  'finishing',
  'shotpower',
  'longshots',
  'volleys',
  'penalties',
  'vision',
  'crossing',
  'freekickaccuracy',
  'shortpassing',
  'longpassing',
  'curve',
  'interceptions',
  'headingaccuracy',
  'defensiveawareness',
  'standingtackle',
  'slidingtackle',
  'jumping',
  'stamina',
  'strength',
  'aggression',
  'composure',
  'gkdiving',
  'gkhandling',
  'gkkicking',
  'gkpositioning',
  'gkreflexes',
] as const;

/** Squad-membership fields, from `teamplayerlinks`. */
export const LINK_OBSERVED_FIELDS = [
  'teamid',
  'position',
  'jerseynumber',
  'form',
  'injury',
  'leagueappearances',
  'leaguegoals',
  'yellows',
  'reds',
] as const;

/** Contract fields, from `career_playercontract`. */
export const CONTRACT_OBSERVED_FIELDS = [
  'wage',
  'duration_months',
  'contract_date',
  'last_status_change_date',
  'playerrole',
  'signon_bonus',
  'contract_status',
] as const;
