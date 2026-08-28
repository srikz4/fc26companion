/**
 * Where FC 26 keeps Manager Career saves, and how to recognise one.
 *
 * spec.md §1.1: verified on this machine. The directory is
 * `%LOCALAPPDATA%\EA SPORTS FC 26\settings`, and the filename prefix changed
 * between titles — FC 25 wrote `ManagerCareer<ts>`, FC 26 writes `CmMgrC<ts>`.
 * A watcher globbing the FC 25 prefix finds nothing at all.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The academy squad's team id, unchanged from FC 25. */
export const YOUTH_TEAM_ID = 112264;

/** Manager Career save: `CmMgrC` + a 17-digit yyyymmddhhmmssSSS stamp. */
export const MANAGER_CAREER_PATTERN = /^CmMgrC(\d{17})$/;

/** Other files in the same directory, listed so they are explicitly not ours. */
export const NON_CAREER_PREFIXES = [
  'CmPlr', // Player Career
  'Squads',
  'FutSquads',
  'MatchDay',
  'Settings',
  'Assets',
] as const;

export function candidateSaveDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  const localAppData = env['LOCALAPPDATA'];
  const userProfile = env['USERPROFILE'];

  if (localAppData) dirs.push(join(localAppData, 'EA SPORTS FC 26', 'settings'));
  // Documents is not used by FC 26 on this machine, but FC 25 documentation
  // referenced it; probe it rather than assume.
  if (userProfile) dirs.push(join(userProfile, 'Documents', 'FC 26', 'settings'));

  return dirs;
}

/** First candidate directory that exists, or null when the game is not installed here. */
export function resolveSaveDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  return candidateSaveDirectories(env).find((dir) => existsSync(dir)) ?? null;
}

export interface SaveFile {
  path: string;
  fileName: string;
  /** The 17-digit stamp from the filename, as written by the game. */
  stamp: string;
  sizeBytes: number;
  modifiedAt: Date;
}

/** List Manager Career saves in a directory, newest first. */
export function listManagerCareerSaves(directory: string): SaveFile[] {
  if (!existsSync(directory)) return [];

  const saves: SaveFile[] = [];
  for (const fileName of readdirSync(directory)) {
    const match = MANAGER_CAREER_PATTERN.exec(fileName);
    if (!match) continue;

    const path = join(directory, fileName);
    const stat = statSync(path);
    if (!stat.isFile()) continue;

    saves.push({
      path,
      fileName,
      stamp: match[1]!,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime,
    });
  }

  return saves.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

/** Newest Manager Career save across all candidate directories. */
export function findLatestManagerCareerSave(env: NodeJS.ProcessEnv = process.env): SaveFile | null {
  const all = candidateSaveDirectories(env).flatMap(listManagerCareerSaves);
  return all.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())[0] ?? null;
}
