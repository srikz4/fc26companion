/**
 * The tagged career blob that follows the `DB\0\x08` databases.
 *
 * After the last database block the save carries a long run of small sections,
 * each introduced by `01 <u32 len=4> <four ascii letters>` — `mobj`, `mssm`,
 * `mcos`, `mrdp` and some seventy others. They are not bit-packed tables; each
 * section serialises one career subsystem.
 *
 * Only `mssm` is decoded here — the in-game transfer shortlist, cracked
 * 2026-08-29 by shortlisting four known players and diffing the save:
 *
 *   mssm
 *   01 01            prelude
 *   <u32>            (observed 1)
 *   00 01
 *   <u32 chunkCount> 0 when the shortlist has never been used
 *   then per chunk:
 *   01 <u32 date YYYYMMDD> <u32 unknown> 01 <u32 count> <count × u32 playerid>
 *
 * Every read is validated — the ids must exist in the `players` table and the
 * date must look like a date — and any surprise returns null rather than a
 * guess. A null renders as "shortlist unreadable", never as an empty list.
 */

export interface ShortlistRead {
  /** Player ids exactly as the game stores them, in stored order. */
  ids: number[];
  /** YYYYMMDD stamp stored with the list, when one chunk exists. */
  date: number | null;
}

const TAG = Buffer.from([0x01, 0x04, 0x00, 0x00, 0x00, 0x6d, 0x73, 0x73, 0x6d]); // 01 len=4 "mssm"

export function readShortlist(
  save: Buffer,
  isPlayerId: (id: number) => boolean,
): ShortlistRead | null {
  const at = save.indexOf(TAG);
  if (at < 0) return null;

  let p = at + TAG.length;
  if (p + 12 > save.length) return null;
  if (save[p] !== 0x01 || save[p + 1] !== 0x01) return null;
  if (save[p + 6] !== 0x00 || save[p + 7] !== 0x01) return null;

  const chunkCount = save.readUInt32LE(p + 8);
  if (chunkCount > 8) return null;

  let cursor = p + 12;
  const ids: number[] = [];
  let date: number | null = null;

  for (let c = 0; c < chunkCount; c++) {
    if (cursor + 14 > save.length) return null;
    if (save[cursor] !== 0x01) return null;
    const stamp = save.readUInt32LE(cursor + 1);
    if (stamp < 20200101 || stamp > 20600101) return null; // YYYYMMDD
    date = stamp;
    if (save[cursor + 9] !== 0x01) return null;
    const count = save.readUInt32LE(cursor + 10);
    if (count > 100) return null;
    cursor += 14;
    if (cursor + count * 4 > save.length) return null;
    for (let i = 0; i < count; i++) {
      const id = save.readUInt32LE(cursor + i * 4);
      if (!isPlayerId(id)) return null;
      ids.push(id);
    }
    cursor += count * 4;
  }

  return { ids, date };
}
