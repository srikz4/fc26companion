/**
 * Nation names, by the id the save uses.
 *
 * The save itself carries no nation-name table (`nations` is empty), but the
 * imported player dataset pairs every nationality id with its name, and the ids
 * are EA's own — 14 England, 45 Spain, 52 Argentina. Extracted once at import
 * time to `data/nations_fc26.csv`; absent file means ids display as ids.
 */
import { existsSync, readFileSync } from 'node:fs';

export function loadNations(path: string): Map<number, string> {
  const map = new Map<number, string>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('nation_id')) continue;
    const comma = line.indexOf(',');
    if (comma === -1) continue;
    const id = Number(line.slice(0, comma));
    let name = line.slice(comma + 1).trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/""/g, '"');
    if (Number.isInteger(id) && id > 0 && name) map.set(id, name);
  }
  return map;
}
