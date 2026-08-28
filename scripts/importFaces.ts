/**
 * Fetch player headshots, once, to local files.
 *
 * The app never touches the network while running (spec.md §3); like the name
 * table, faces arrive through an explicit import step and are served from disk
 * afterwards. Sprites are keyed by EA's internal playerid on the community CDN,
 * which is the same id the save uses — the same trick that solved names.
 *
 * Newgens have no sprite anywhere (they exist only in this career); a 404 here
 * is normal and the UI falls back to an initials disc.
 *
 *   npm run import:faces          # squad + academy + current transfer targets
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbMeta } from '../src/parser/meta.ts';
import { parseSave } from '../src/parser/dbReader.ts';
import { listManagerCareerSaves, resolveSaveDirectory, YOUTH_TEAM_ID } from '../src/core/saveLocation.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const FACES_DIR = join(root, 'data', 'faces');
const CDN = 'https://cdn.futwiz.com/assets/img/fc26/faces';

async function main(): Promise<void> {
  const dir = resolveSaveDirectory();
  const save = dir ? listManagerCareerSaves(dir)[0] : undefined;
  if (!save) {
    console.error('No save found.');
    process.exit(1);
  }

  const meta = loadDbMeta(join(root, 'data', 'fifa_ng_db-meta.xml'));
  const tables = parseSave(readFileSync(save.path), meta).tables;
  const clubId = tables['career_users']?.[0]?.['clubteamid'];

  const wanted = new Set<number>();
  for (const link of tables['teamplayerlinks'] ?? []) {
    if (link['teamid'] === clubId || link['teamid'] === YOUTH_TEAM_ID) {
      if (typeof link['playerid'] === 'number') wanted.add(link['playerid']);
    }
  }
  // A broad slice of the world so transfer targets have faces too.
  for (const p of tables['players'] ?? []) {
    if (typeof p['playerid'] === 'number' && typeof p['overallrating'] === 'number') {
      if (p['overallrating'] >= 78 && p['playerid'] < 400_000) wanted.add(p['playerid']);
    }
  }

  mkdirSync(FACES_DIR, { recursive: true });
  let got = 0;
  let missing = 0;
  let skipped = 0;

  for (const id of wanted) {
    const path = join(FACES_DIR, `${id}.png`);
    if (existsSync(path)) {
      skipped++;
      continue;
    }
    try {
      const response = await fetch(`${CDN}/${id}.png`);
      if (!response.ok) {
        missing++;
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      // Anything under 500 bytes is an error page, not a face.
      if (bytes.length < 500) {
        missing++;
        continue;
      }
      writeFileSync(path, bytes);
      got++;
      if (got % 100 === 0) console.log(`  ${got} fetched…`);
    } catch {
      missing++;
    }
  }

  console.log(`faces: ${got} fetched, ${skipped} already present, ${missing} unavailable (newgens have none — expected).`);
  console.log(`stored in ${FACES_DIR}`);
}

main();
