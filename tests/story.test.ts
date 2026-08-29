import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStoryEvents, type StoryInput } from '../src/engine/story.ts';
import { HistoryStore } from '../src/store/store.ts';
import type { Tables } from '../src/parser/dbReader.ts';

const base = (overrides: Partial<Tables> = {}): Tables => ({
  career_competitionprogress: [
    { season: 2, compshortname: 'C202', hasteamwon: 1, compobjid: 617 },
    { season: 3, compshortname: 'C201', hasteamwon: 0, compobjid: 501 },
  ],
  career_managerhistory: [
    { season: 1, tableposition: 2, wins: 29, draws: 7, losses: 9, points: 94, bigsellplayername: 'Ponce', bigsellamount: 1 },
    { season: 2, tableposition: 1, wins: 49, draws: 7, losses: 10, points: 154 },
  ],
  career_managerinfo: [
    { bigwinuserscore: 13, bigwinoppscore: 0, bigwindate: 20260801, bigwinoppteamid: 99, biglossuserscore: 0, biglossoppscore: 4, biglossdate: 20260207, biglossoppteamid: 18 },
  ],
  ...overrides,
});

const input = (overrides: Partial<StoryInput> = {}): StoryInput => ({
  tables: base(),
  careerId: 1,
  snapshotId: 1,
  gameDate: 20270807,
  season: 3,
  nameOf: (id) => `player ${id}`,
  teamNameOf: (id) => (id === 99 ? 'Bengaluru FC' : `team ${id}`),
  competitionOf: (code) => (code === 'C202' ? 'EFL Cup' : null),
  seniorIds: new Set<number>(),
  academyIds: new Set<number>(),
  overallOf: () => null,
  ...overrides,
});

describe('the story ledger', () => {
  test('records trophies, finishes and record scorelines with their own dates', () => {
    const events = deriveStoryEvents(input());
    const byKind = (k: string) => events.filter((e) => e.kind === k);

    assert.equal(byKind('trophy').length, 1, 'only a won competition is a trophy');
    assert.equal(byKind('trophy')[0]!.title, 'Won EFL Cup');

    assert.equal(byKind('season').length, 2);
    assert.ok(byKind('season').some((e) => e.title === 'Champions in season 2'));
    assert.ok(byKind('season').some((e) => e.title === 'Finished 2nd in season 1'));

    const win = byKind('record-win')[0]!;
    assert.equal(win.title, 'Beat Bengaluru FC 13–0');
    // Dated by the match, not by the parse.
    assert.equal(win.gameDate, 20260801);
    // And filed under the season it was set in: today is Aug 2027 in season 3,
    // so a result from Aug 2026 belongs to season 2, not to today.
    assert.equal(win.season, 2);
    assert.equal(byKind('record-loss')[0]!.season, 1, 'Feb 2026 sits in season 1');
  });

  test('a promotion needs a previous look, not a guess', () => {
    const without = deriveStoryEvents(input({ seniorIds: new Set([7]) }));
    assert.equal(without.filter((e) => e.kind === 'promotion').length, 0);

    const with_ = deriveStoryEvents(
      input({ seniorIds: new Set([7]), previousAcademyIds: new Set([7]) }),
    );
    assert.equal(with_.filter((e) => e.kind === 'promotion').length, 1);
  });

  test('rating milestones fire on the crossing, not on the level', () => {
    const shared = { seniorIds: new Set([7]), overallOf: () => 86 };
    const crossed = deriveStoryEvents(input({ ...shared, previousOverall: new Map([[7, 84]]) }));
    assert.deepEqual(
      crossed.filter((e) => e.kind === 'milestone').map((e) => e.key),
      ['rating:7:85'],
      'crossing 85 is one event, and 80 was already passed',
    );

    const steady = deriveStoryEvents(input({ ...shared, previousOverall: new Map([[7, 86]]) }));
    assert.equal(steady.filter((e) => e.kind === 'milestone').length, 0);
  });

  test('the store writes an event once and keeps the first sighting', () => {
    const store = new HistoryStore(':memory:');
    const db = store.handle;
    db.prepare(
      `INSERT INTO career (career_id, club_team_id, club_name, manager_name, identity_key, first_seen_at, last_seen_at)
       VALUES (1, 11, 'Club', 'Manager', 'k', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO snapshot (snapshot_id, career_id, content_hash, source_file, size_bytes, observed_at, parser_version)
       VALUES (1, 1, 'h', 'f', 1, 'now', '0.1.0')`,
    ).run();

    const event = {
      careerId: 1,
      key: 'trophy:2:C202',
      kind: 'trophy',
      season: 2,
      title: 'Won EFL Cup',
      gameDate: 20270101,
      snapshotId: 1,
    };
    assert.equal(store.recordStory([event]), 1);
    // The same event derived again from a later save must change nothing.
    assert.equal(store.recordStory([{ ...event, gameDate: 20270901, title: 'Won EFL Cup (again)' }]), 0);

    const ledger = store.story(1);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.gameDate, 20270101, 'the first sighting keeps its date');
    assert.equal(ledger[0]!.title, 'Won EFL Cup');
    store.close();
  });

  test('a corrected derivation reclassifies without moving the date', () => {
    const store = new HistoryStore(':memory:');
    const db = store.handle;
    db.prepare(
      `INSERT INTO career (career_id, club_team_id, club_name, manager_name, identity_key, first_seen_at, last_seen_at)
       VALUES (1, 11, 'Club', 'Manager', 'k', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO snapshot (snapshot_id, career_id, content_hash, source_file, size_bytes, observed_at, parser_version)
       VALUES (1, 1, 'h', 'f', 1, 'now', '0.1.0')`,
    ).run();

    // Recorded by an earlier, buggy deriver that filed every record under the
    // current season.
    store.recordStory([
      { careerId: 1, key: 'record:win:20260801:13-0', kind: 'record-win', season: 3, title: 'Beat X 13–0', gameDate: 20260801, snapshotId: 1 },
    ]);
    const fixed = store.reclassifyStory([
      { careerId: 1, key: 'record:win:20260801:13-0', kind: 'record-win', season: 2, title: 'Beat X 13–0', gameDate: 20260801, snapshotId: 1 },
    ]);
    assert.equal(fixed, 1);

    const [row] = store.story(1);
    assert.equal(row!.season, 2, 'the shelf moved');
    assert.equal(row!.gameDate, 20260801, 'the date did not');
    // Re-running the corrected deriver changes nothing further.
    assert.equal(
      store.reclassifyStory([
        { careerId: 1, key: 'record:win:20260801:13-0', kind: 'record-win', season: 2, title: 'Beat X 13–0', gameDate: 20260801, snapshotId: 1 },
      ]),
      0,
    );
    store.close();
  });
});
