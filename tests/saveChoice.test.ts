import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSaveChoice, rejectSavePath, writeSaveChoice } from '../src/core/saveChoice.ts';

let dir: string;
let savePath: string;
let configPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'companion-save-'));
  savePath = join(dir, 'CmMgrC20260101000000000');
  writeFileSync(savePath, Buffer.alloc(4096));
  configPath = join(dir, 'store', 'save-choice.json');
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('rejectSavePath', () => {
  it('accepts a real file of a plausible size', () => {
    assert.equal(rejectSavePath(savePath), null);
  });

  it('explains what is wrong rather than just failing', () => {
    assert.match(rejectSavePath(join(dir, 'nope')) ?? '', /No file/);
    assert.match(rejectSavePath('   ') ?? '', /Give a path/);
    const folder = join(dir, 'afolder');
    mkdirSync(folder);
    assert.match(rejectSavePath(folder) ?? '', /folder/);
    const tiny = join(dir, 'tiny.bin');
    writeFileSync(tiny, 'x');
    assert.match(rejectSavePath(tiny) ?? '', /too small/);
  });
});

describe('the remembered save choice', () => {
  it('starts out following the newest save', () => {
    assert.deepEqual(readSaveChoice(configPath), { path: null, chosenAt: null });
  });

  it('remembers a choice across a restart', () => {
    const written = writeSaveChoice(configPath, savePath);
    assert.equal(written.path, savePath);
    assert.ok(written.chosenAt);
    assert.equal(readSaveChoice(configPath).path, savePath);
  });

  it('forgets a file that is no longer there, rather than failing to start', () => {
    const gone = join(dir, 'deleted-save');
    writeFileSync(gone, Buffer.alloc(4096));
    writeSaveChoice(configPath, gone);
    rmSync(gone);
    assert.deepEqual(readSaveChoice(configPath), { path: null, chosenAt: null });
  });

  it('goes back to the newest save when the choice is cleared', () => {
    writeSaveChoice(configPath, savePath);
    assert.equal(writeSaveChoice(configPath, null).path, null);
    assert.equal(readSaveChoice(configPath).path, null);
  });

  it('treats an unreadable config as no choice at all', () => {
    writeFileSync(configPath, 'not json');
    assert.deepEqual(readSaveChoice(configPath), { path: null, chosenAt: null });
  });
});
