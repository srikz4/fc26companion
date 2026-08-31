/**
 * A QR encoder, because the alternative was a web request.
 *
 * Every "make a QR code" service is a URL you hand your data to, and this app's
 * whole posture is that it never talks to the network. So the code is generated
 * here: byte mode, error correction level M, versions 1 to 10, which is far
 * more than a LAN address needs.
 *
 * Nothing clever — it is the specification, written out. Format and version
 * information are computed from their BCH polynomials rather than copied from a
 * table, because a mistyped table entry produces a code that scans as garbage
 * and looks perfectly fine.
 */

// --- GF(256), the field Reed-Solomon lives in --------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d; // the primitive polynomial QR specifies
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` error-correction codewords. */
function generator(degree) {
  let poly = [1];
  for (let d = 0; d < degree; d++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= mul(poly[i], EXP[d]);
      next[i + 1] ^= poly[i];
    }
    poly = next;
  }
  return poly;
}

function ecCodewords(data, count) {
  const gen = generator(count);
  const rem = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// --- version tables, level M -------------------------------------------------
// [ec codewords per block, group1 blocks, group1 data, group2 blocks, group2 data]
const BLOCKS_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};
const ALIGN = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const dataCapacity = (v) => {
  const [, g1b, g1d, g2b, g2d] = BLOCKS_M[v];
  return g1b * g1d + g2b * g2d;
};

/** Remainder of `value` under `generator`, for the BCH-protected metadata. */
function bch(value, gen, genBits) {
  let v = value;
  const width = 32 - Math.clz32(gen);
  while (32 - Math.clz32(v) >= width) v ^= gen << (32 - Math.clz32(v) - width);
  return v;
}

// --- the encoder -------------------------------------------------------------
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= 10; v++) {
    // 4 bits mode + 8 bits length (versions 1-9) + the data itself
    const overhead = v <= 9 ? 2 : 3;
    if (bytes.length + overhead <= dataCapacity(v)) {
      version = v;
      break;
    }
  }
  if (!version) return null; // too long for anything we support

  const [ecPerBlock, g1b, g1d, g2b, g2d] = BLOCKS_M[version];
  const capacity = dataCapacity(version);

  // Bit stream: mode, length, payload, terminator, padding.
  const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let i = 0; words.length < capacity; i++) words.push(i % 2 ? 0x11 : 0xec);

  // Split into blocks, compute EC for each, then interleave both.
  const blocks = [];
  let at = 0;
  for (let i = 0; i < g1b; i++) {
    blocks.push(words.slice(at, at + g1d));
    at += g1d;
  }
  for (let i = 0; i < g2b; i++) {
    blocks.push(words.slice(at, at + g2d));
    at += g2d;
  }
  const ecs = blocks.map((b) => ecCodewords(b, ecPerBlock));

  const final = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) final.push(b[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const e of ecs) final.push(e[i]);

  // --- lay out the symbol ----------------------------------------------------
  const size = 17 + version * 4;
  const grid = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const put = (r, c, dark) => {
    grid[r][c] = dark;
    reserved[r][c] = true;
  };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const r1 = r0 + r;
        const c1 = c0 + c;
        if (r1 < 0 || c1 < 0 || r1 >= size || c1 >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark =
          inRing &&
          ((r === 0 || r === 6 || c === 0 || c === 6) || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        put(r1, c1, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }

  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if (reserved[r][c]) continue; // the three that clash with finders
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          put(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  put(size - 8, 8, true); // the always-dark module

  // Reserve the format areas before data goes anywhere near them.
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      reserved[Math.floor(i / 3)][size - 11 + (i % 3)] = true;
      reserved[size - 11 + (i % 3)][Math.floor(i / 3)] = true;
    }
  }

  // Data snakes up and down two columns at a time, right to left.
  let bitAt = 0;
  const nextBit = () => {
    const byte = final[bitAt >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (bitAt & 7))) & 1;
    bitAt++;
    return bit === 1;
  };
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // the vertical timing line is not a data column
    for (let i = 0; i < size; i++) {
      const up = ((size - 1 - col) >> 1) % 2 === 0;
      const row = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        grid[row][c] = nextBit();
      }
    }
  }

  // --- masking ---------------------------------------------------------------
  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  const penalty = (m) => {
    let score = 0;
    const runs = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          if (get(a, b) === get(a, b - 1)) run++;
          else {
            if (run >= 5) score += run - 2;
            run = 1;
          }
        }
        if (run >= 5) score += run - 2;
      }
    };
    runs((a, b) => m[a][b]);
    runs((a, b) => m[b][a]);
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    const pattern = [true, false, true, true, true, false, true, false, false, false, false];
    const hasAt = (get, a, b) => pattern.every((want, k) => get(a, b + k) === want);
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 11 <= size; b++) {
        if (hasAt((x, y) => m[x][y], a, b)) score += 40;
        if (hasAt((x, y) => m[y][x], a, b)) score += 40;
      }
    }
    const dark = m.flat().filter(Boolean).length;
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  };

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = grid.map((row, r) => row.map((v, c) => (reserved[r][c] ? v === true : v !== MASKS[mask](r, c))));

    // Format information: level M is 00, then the mask, BCH-protected.
    const fmt = ((0b00 << 3) | mask) << 10;
    const formatBits = ((fmt | bch(fmt, 0x537)) ^ 0x5412) >>> 0;
    for (let i = 0; i < 15; i++) {
      const bit = ((formatBits >> i) & 1) === 1;
      if (i < 6) m[8][i] = bit;
      else if (i < 8) m[8][i + 1] = bit;
      else m[8 + 8 - i][8] = bit;
      if (i < 8) m[size - 1 - i][8] = bit;
      else m[8][size - 15 + i] = bit;
    }
    m[8][6] = m[8][6];
    m[6][8] = m[6][8];

    if (version >= 7) {
      const vi = (version << 12) | bch(version << 12, 0x1f25);
      for (let i = 0; i < 18; i++) {
        const bit = ((vi >> i) & 1) === 1;
        m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
        m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }

    const score = penalty(m);
    if (!best || score < best.score) best = { score, m };
  }

  return best.m;
}

/** The matrix as an SVG element, sized to fit its container. */
export function qrSvg(text, { quiet = 3, className = 'qr' } = {}) {
  const m = qrMatrix(text);
  if (!m) return null;
  const size = m.length;
  const total = size + quiet * 2;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `QR code for ${text}`);
  svg.classList.add(className);

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', String(total));
  bg.setAttribute('height', String(total));
  bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);

  // One path for every dark module keeps the DOM small and the render crisp.
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (m[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.appendChild(path);
  return svg;
}
