/**
 * Decoding for EA's edited-name string fields.
 *
 * `editedplayernames` fields are fixed-width (45 bytes) and hold one of two forms:
 *
 *   plain      "Lino\0..."            4c 69 6e 6f 00 ...
 *   prefixed   <u16 code>"rtín\0..."  17 00 72 74 c3 ad 6e 00 ...
 *
 * The prefixed form is a dictionary compression: a little-endian u16 code standing
 * for a common name prefix, followed by the UTF-8 remainder. Observed in this
 * save: 0x0017 + "rtín", 0x000c + "cente", 0x001d + "ephen", 0x0021 + "tur" —
 * i.e. Martín, Vicente, Stephen, Artur.
 *
 * **The dictionary is not in the save.** It ships with the game, so a prefixed
 * name cannot be reconstructed here. We decode the suffix, report the code, and
 * mark the value incomplete; callers must not display an incomplete name as if it
 * were whole (spec.md §3, "no silent fallback"). Rendering the suffix alone gives
 * "tur Roth" for Artur Roth, which reads as a real name and is not one.
 *
 * Note on prior art: fc26companion's `EA_STR_PREFIX_MAP` had spotted this pattern
 * and several of its entries decode correctly (0x21→"Ar", 0x18→"Ju", 0x06→"Lu",
 * 0x10→"St"). It keyed on a single byte rather than the u16 and filled the gaps by
 * guessing, which is why it produced confident wrong names — but the underlying
 * observation was sound. See spec.md §9 E-1.
 */

export interface DecodedName {
  /** The text we can actually vouch for. Empty when nothing decodable is present. */
  text: string;
  /** False when a dictionary prefix was stripped, so `text` is a suffix, not a name. */
  complete: boolean;
  /** The u16 dictionary code, when the prefixed form was detected. */
  prefixCode?: number;
}

export const EMPTY_NAME: DecodedName = { text: '', complete: true };

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8OrLatin1(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    text = Buffer.from(bytes).toString('latin1');
  }
  return text.replace(CONTROL_CHARS, '').trim();
}

/**
 * Decode one fixed-width name field.
 *
 * The prefixed form is identified by a null at index 1 with a non-null at index 0
 * and more content after it. A genuine one-character name is `X\0\0...`, which has
 * no content after the null pair and so decodes as plain.
 */
export function decodeName(field: Uint8Array): DecodedName {
  if (field.length === 0) return EMPTY_NAME;

  const terminator = field.indexOf(0);
  if (terminator === 0) {
    // Either an empty field or the prefixed form beginning with code byte 0x00.
    const isPrefixed = field.length > 2 && field[1] === 0 && field[2] !== 0;
    if (!isPrefixed) return EMPTY_NAME;
  }

  const looksPrefixed =
    field.length > 2 && field[1] === 0 && field[2] !== undefined && field[2] !== 0;

  if (looksPrefixed) {
    const prefixCode = field[0]! | (field[1]! << 8);
    const rest = field.subarray(2);
    const end = rest.indexOf(0);
    const suffix = decodeUtf8OrLatin1(end === -1 ? rest : rest.subarray(0, end));
    return { text: suffix, complete: false, prefixCode };
  }

  const body = terminator === -1 ? field : field.subarray(0, terminator);
  return { text: decodeUtf8OrLatin1(body), complete: true };
}

/**
 * Render a decoded name for display, or null when it cannot be shown honestly.
 * An incomplete name is never rendered — the caller falls back to `#playerid`.
 */
export function displayName(name: DecodedName): string | null {
  if (!name.complete) return null;
  return name.text.length > 0 ? name.text : null;
}
