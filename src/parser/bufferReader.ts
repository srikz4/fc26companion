/**
 * Sequential little-endian reader over a save buffer.
 *
 * Ported from fc25/watcher/src/lib/buffer_reader.js. The FC 25 implementation is
 * correct; this adds bounds checks so a malformed save fails loudly at the byte
 * that broke rather than yielding NaN downstream (spec.md §3, "no silent fallback").
 */
export class BufferReader {
  readonly buffer: Buffer;
  position: number;

  constructor(buffer: Buffer, position = 0) {
    this.buffer = buffer;
    this.position = position;
  }

  private require(bytes: number): number {
    const at = this.position;
    if (at < 0 || at + bytes > this.buffer.length) {
      throw new RangeError(
        `read of ${bytes} byte(s) at ${at} exceeds buffer length ${this.buffer.length}`,
      );
    }
    return at;
  }

  readUInt8(): number {
    const at = this.require(1);
    this.position = at + 1;
    return this.buffer[at]!;
  }

  readUInt16LE(): number {
    const at = this.require(2);
    this.position = at + 2;
    return this.buffer.readUInt16LE(at);
  }

  readUInt32LE(): number {
    const at = this.require(4);
    this.position = at + 4;
    return this.buffer.readUInt32LE(at);
  }

  readBytes(length: number): Buffer {
    const at = this.require(length);
    this.position = at + length;
    return this.buffer.subarray(at, at + length);
  }

  skip(length: number): void {
    this.require(length);
    this.position += length;
  }
}
