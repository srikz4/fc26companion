/**
 * Build the Windows icon from the same mark the web app uses.
 *
 *   npm run make:icon
 *
 * The desktop shortcut looked ragged because `favicon.ico` held exactly one
 * 32x32 image. Windows draws the desktop at 48 and the large-icon views well
 * past that, so it was upscaling a small bitmap every time — and upscaling a
 * hairline pitch outline is precisely what produces stair-stepped edges.
 *
 * The fix is not a bigger single image, it is one image per size Windows asks
 * for, each drawn at that size rather than resampled into it. So the mark is
 * rendered here from its own geometry rather than traced out of the SVG:
 *
 *  - Coverage comes from a signed distance field, so an edge is shaded by how
 *    much of the pixel the shape actually covers. That is what removes the
 *    stair-stepping, and it costs nothing at these sizes.
 *  - Strokes have a floor of just over one pixel. A 3-unit stroke on a 64-unit
 *    canvas is 0.75px at 16x16, which renders as a grey smear; held at 1.1px it
 *    stays a line.
 *  - The centre circle is dropped below 20px, and the spot below 24px. At those
 *    sizes a ring under two pixels across around a half-pixel dot is a blob,
 *    and a blob reads worse than a clean pitch with nothing in the middle.
 *
 * Every entry is a 32-bit BMP, including the 256. PNG entries are legal since
 * Vista and would save 260KB, but they are not universally understood — .NET's
 * own icon loader ignores them and falls back to upscaling the next size down,
 * which is the failure this whole file exists to remove. A third of a megabyte
 * on disk is a cheap price for never being resampled.
 *
 * Two files come out, because they have different jobs. `Companion.ico` is for
 * the shell and carries every size Windows asks for. `web/favicon.ico` is served
 * to browsers, which only ever want the small ones, so it carries four.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The mark, in the 64-unit space the SVG uses. */
const INK = { r: 0xc9, g: 0xf2, b: 0x4b };
const BACKDROP = { r: 0x0b, g: 0x0f, b: 0x14 };
const SHELL_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const BROWSER_SIZES = [16, 24, 32, 48];

interface Vec {
  x: number;
  y: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Distance from a point to a rounded rectangle, negative inside. */
function sdRoundRect(p: Vec, centre: Vec, halfW: number, halfH: number, radius: number): number {
  const qx = Math.abs(p.x - centre.x) - (halfW - radius);
  const qy = Math.abs(p.y - centre.y) - (halfH - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const sdCircle = (p: Vec, centre: Vec, radius: number): number =>
  Math.hypot(p.x - centre.x, p.y - centre.y) - radius;

/** Distance to a horizontal segment, which is all this mark needs. */
function sdHSegment(p: Vec, y: number, x0: number, x1: number): number {
  const dx = p.x < x0 ? x0 - p.x : p.x > x1 ? p.x - x1 : 0;
  return Math.hypot(dx, p.y - y);
}

/**
 * Coverage of a pixel by a shape, from its distance field. Half a pixel either
 * side of the boundary ramps from covered to not, which is what an antialiased
 * edge is.
 */
const cover = (distance: number): number => clamp01(0.5 - distance);

/** Paint over a straight (unpremultiplied) RGBA accumulator. */
function over(dst: number[], src: { r: number; g: number; b: number }, alpha: number): void {
  if (alpha <= 0) return;
  const a = alpha + dst[3]! * (1 - alpha);
  if (a <= 0) {
    dst[0] = 0;
    dst[1] = 0;
    dst[2] = 0;
    dst[3] = 0;
    return;
  }
  dst[0] = (src.r * alpha + dst[0]! * dst[3]! * (1 - alpha)) / a;
  dst[1] = (src.g * alpha + dst[1]! * dst[3]! * (1 - alpha)) / a;
  dst[2] = (src.b * alpha + dst[2]! * dst[3]! * (1 - alpha)) / a;
  dst[3] = a;
}

/** RGBA, top-down, eight bits a channel. */
function render(size: number): Buffer {
  const s = size / 64;
  const px = (v: number): number => v * s;
  const out = Buffer.alloc(size * size * 4);

  const stroke = Math.max(3 * s, 1.1) / 2;

  /**
   * Hinting: put a stroke's centreline down the middle of a pixel.
   *
   * Unhinted, the pitch's vertical edges landed on a pixel boundary and spread
   * across two columns at half coverage each, while the horizontals happened to
   * land on centres and stayed crisp — so one icon had sharp top and bottom and
   * soft sides. Snapping every edge to a half-integer fixes that. Only worth
   * doing while a pixel is a large fraction of a stroke; past 48px the geometry
   * is better served left alone.
   */
  const snap = (v: number): number => (size <= 48 ? Math.round(v - 0.5) + 0.5 : v);
  const left = snap(px(8));
  const right = snap(px(56));
  const top = snap(px(10));
  const bottom = snap(px(54));

  const centre: Vec = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const tile: Vec = { x: size / 2, y: size / 2 };
  const showRing = size >= 20;
  const spotRadius = size >= 24 ? Math.max(2.4 * s, 1.05) : 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p: Vec = { x: x + 0.5, y: y + 0.5 };
      const rgba = [0, 0, 0, 0];

      over(rgba, BACKDROP, cover(sdRoundRect(p, tile, size / 2, size / 2, px(14))));

      const outline = sdRoundRect(p, centre, (right - left) / 2, (bottom - top) / 2, px(4));
      over(rgba, INK, cover(Math.abs(outline) - stroke));
      over(rgba, INK, cover(sdHSegment(p, centre.y, left, right) - stroke));
      if (showRing) over(rgba, INK, cover(Math.abs(sdCircle(p, centre, px(7))) - stroke));
      if (spotRadius > 0) over(rgba, INK, cover(sdCircle(p, centre, spotRadius)));

      const i = (y * size + x) * 4;
      out[i] = Math.round(rgba[0]!);
      out[i + 1] = Math.round(rgba[1]!);
      out[i + 2] = Math.round(rgba[2]!);
      out[i + 3] = Math.round(rgba[3]! * 255);
    }
  }
  return out;
}

/** A 32-bit BMP icon image: header, BGRA bottom-up, then the legacy AND mask. */
function bmpEntry(rgba: Buffer, size: number): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour rows plus mask rows, as the format wants
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      pixels[dst] = rgba[src + 2]!;
      pixels[dst + 1] = rgba[src + 1]!;
      pixels[dst + 2] = rgba[src]!;
      pixels[dst + 3] = rgba[src + 3]!;
    }
  }

  // Every pixel opts into the alpha channel, so the mask stays zero — but the
  // shell still expects it to be there and correctly sized.
  const maskStride = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size)]);
}

function buildIco(sizes: number[]): Buffer {
  const images = sizes.map((size) => ({ size, data: bmpEntry(render(size), size) }));
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // an icon, not a cursor
  dir.writeUInt16LE(images.length, 4);

  let offset = dir.length;
  images.forEach((img, i) => {
    const at = 6 + i * 16;
    dir[at] = img.size >= 256 ? 0 : img.size; // zero means 256
    dir[at + 1] = img.size >= 256 ? 0 : img.size;
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(img.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

for (const [target, sizes] of [
  [join(root, 'Companion.ico'), SHELL_SIZES],
  [join(root, 'web', 'favicon.ico'), BROWSER_SIZES],
] as const) {
  const ico = buildIco([...sizes]);
  writeFileSync(target, ico);
  console.log(`${target.replace(root, '')}  ${(ico.length / 1024).toFixed(0)} KB  ${sizes.join(', ')}`);
}
