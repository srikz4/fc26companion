/**
 * Which save file Companion is reading.
 *
 * By default it follows the newest Manager Career save the game writes, which is
 * what you want while you are playing. But a save is just a file: one downloaded
 * from a friend, restored from a backup, or copied off another machine is every
 * bit as readable, and there is no reason the app should insist on the one the
 * game happens to have touched last.
 *
 * The choice lives beside the history store rather than in the repository — it
 * is a fact about this machine, not about the project — and it is remembered
 * across restarts. Choosing a file also moves the watcher: it stops looking at
 * the game's own folder and watches the chosen file's folder instead, so a save
 * you overwrite from outside the game still lands on screen by itself.
 *
 * Nothing here reaches the network. A "downloaded" save means one already on
 * disk; Companion only ever opens a local path.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SaveChoice {
  /** Absolute path the user picked, or null to follow the newest save. */
  path: string | null;
  /** When the choice was made, for the settings screen. */
  chosenAt: string | null;
}

const EMPTY: SaveChoice = { path: null, chosenAt: null };

export function readSaveChoice(configPath: string): SaveChoice {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<SaveChoice>;
    const path = typeof raw.path === 'string' && raw.path.length > 0 ? raw.path : null;
    // A file that has since been moved or deleted is not a choice any more.
    if (path === null || !existsSync(path)) return EMPTY;
    return { path, chosenAt: typeof raw.chosenAt === 'string' ? raw.chosenAt : null };
  } catch {
    return EMPTY;
  }
}

export function writeSaveChoice(configPath: string, path: string | null): SaveChoice {
  const choice: SaveChoice = {
    path: path && path.length > 0 ? path : null,
    chosenAt: path ? new Date().toISOString() : null,
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(choice, null, 2)}\n`, 'utf8');
  return choice;
}

export interface SaveCandidate {
  path: string;
  name: string;
  sizeBytes: number;
  modified: string;
  /** True when this is the file currently being read. */
  active: boolean;
}

/**
 * Why a path cannot be used, or null when it can.
 *
 * Deliberately about the file rather than its contents: whether the bytes parse
 * is the parser's business, and it will say so on screen if they do not.
 */
export function rejectSavePath(path: string): string | null {
  if (!path.trim()) return 'Give a path to a save file.';
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 'No file at that path.';
  }
  if (stat.isDirectory()) return 'That is a folder. Point at the save file itself.';
  if (stat.size < 1024) return 'That file is too small to be a career save.';
  return null;
}
