/**
 * Save watcher (spec.md §2.1).
 *
 * The game writes the save in several passes, so a naive listener fires on a
 * half-written file. The sequence here is: notice, wait for writes to settle,
 * hash, skip if unchanged, copy, parse the copy, append.
 *
 * The original save is opened read-only and never moved, renamed or written.
 */
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { MANAGER_CAREER_PATTERN, listManagerCareerSaves } from '../core/saveLocation.ts';
import { parseSave, type ParseResult } from '../parser/dbReader.ts';
import type { DbMeta } from '../parser/meta.ts';
import { HistoryStore, hashSave, type IngestResult } from '../store/store.ts';

export interface WatcherOptions {
  saveDirectory: string;
  snapshotDirectory: string;
  meta: DbMeta;
  store: HistoryStore;
  /** Writes settle before we read. 3000 ms, not 800 — the game writes in passes. */
  debounceMs?: number;
  /** A locked file is retried rather than reported as an error. */
  retries?: number;
  retryDelayMs?: number;
}

export interface ProcessedEvent {
  file: string;
  result: IngestResult;
  parseMs: number;
  copiedTo: string;
}

export interface WatcherEvents {
  detected: [file: string];
  processed: [event: ProcessedEvent];
  skipped: [file: string, reason: 'unchanged' | 'duplicate'];
  error: [error: Error, file: string];
}

const DEFAULTS = { debounceMs: 3000, retries: 3, retryDelayMs: 1000 };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SaveWatcher extends EventEmitter<WatcherEvents> {
  private readonly options: Required<WatcherOptions>;
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  /** One save processed at a time; consecutive writes queue (spec.md §2.1). */
  private queue: Promise<void> = Promise.resolve();
  private lastHash = new Map<string, string>();
  private stopped = false;

  constructor(options: WatcherOptions) {
    super();
    this.options = { ...DEFAULTS, ...options };
  }

  start(): void {
    this.stopped = false;
    this.watcher = watch(this.options.saveDirectory, (_event, fileName) => {
      if (!fileName || !MANAGER_CAREER_PATTERN.test(fileName)) return;
      this.schedule(fileName);
    });
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Ingest the newest save on disk without waiting for a write. */
  async ingestLatest(): Promise<ProcessedEvent | null> {
    const saves = listManagerCareerSaves(this.options.saveDirectory);
    const newest = saves[0];
    if (!newest) return null;
    return this.process(newest.fileName);
  }

  /** Ingest every save present, oldest first — backfills history from what exists. */
  async ingestAll(): Promise<ProcessedEvent[]> {
    const saves = listManagerCareerSaves(this.options.saveDirectory).slice().reverse();
    const done: ProcessedEvent[] = [];
    for (const save of saves) {
      const event = await this.process(save.fileName);
      if (event) done.push(event);
    }
    return done;
  }

  private schedule(fileName: string): void {
    this.emit('detected', fileName);
    const existing = this.timers.get(fileName);
    if (existing) clearTimeout(existing);

    this.timers.set(
      fileName,
      setTimeout(() => {
        this.timers.delete(fileName);
        this.enqueue(fileName);
      }, this.options.debounceMs),
    );
  }

  private enqueue(fileName: string): void {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        await this.process(fileName);
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)), fileName);
      }
    });
  }

  /** Read with retries: the game may still hold the handle. */
  private async readWhenReadable(path: string): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        return await readFile(path);
      } catch (error) {
        lastError = error;
        if (attempt < this.options.retries) await sleep(this.options.retryDelayMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async process(fileName: string): Promise<ProcessedEvent | null> {
    const path = join(this.options.saveDirectory, fileName);
    const bytes = await this.readWhenReadable(path);
    const contentHash = hashSave(bytes);

    if (this.lastHash.get(fileName) === contentHash) {
      this.emit('skipped', fileName, 'unchanged');
      return null;
    }

    const startedAt = performance.now();
    const parsed: ParseResult = parseSave(bytes, this.options.meta);
    const parseMs = Math.round(performance.now() - startedAt);

    // Copy under the career the save belongs to, so parallel careers stay apart.
    const stamp = MANAGER_CAREER_PATTERN.exec(fileName)?.[1] ?? null;
    const copiedTo = await this.copySnapshot(bytes, contentHash, stamp);

    const info = await stat(path);
    const result = this.options.store.ingest({
      parsed,
      contentHash,
      sourceFile: path,
      sourceStamp: stamp,
      copiedTo,
      sizeBytes: info.size,
      parseMs,
    });

    this.lastHash.set(fileName, contentHash);

    if (result.duplicate) {
      this.emit('skipped', fileName, 'duplicate');
      return null;
    }

    const event: ProcessedEvent = { file: fileName, result, parseMs, copiedTo };
    this.emit('processed', event);
    return event;
  }

  private async copySnapshot(
    bytes: Buffer,
    contentHash: string,
    stamp: string | null,
  ): Promise<string> {
    const dir = join(this.options.snapshotDirectory, contentHash.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${stamp ?? 'unknown'}_${contentHash.slice(0, 8)}.bin`);
    // Write our own copy from the bytes already in hand rather than re-reading the
    // save; the original is never touched again.
    await writeFile(target, bytes, { flag: 'w' });
    return target;
  }
}
