import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildViewDocument } from '../src/engine/viewModel.ts';
import { createNameResolver } from '../src/names/nameTable.ts';
import { readPlayStyles } from '../src/domain/playstyles.ts';
import { ageAt, dateFromDays, potentialTag } from '../src/domain/attributes.ts';
import { YOUTH_TEAM_ID } from '../src/core/saveLocation.ts';
import type { Tables } from '../src/parser/dbReader.ts';

const CLUB = 11;

function save(overrides: Partial<Tables> = {}): Tables {
  return {
    career_users: [{ firstname: 'Marc', surname: 'Skinner', clubteamid: CLUB, seasoncount: 2 }],
    career_managerinfo: [{ clubteamid: CLUB }],
    teams: [{ teamid: CLUB, teamname: 'Manchester United', overallrating: 80 }],
    persistent_events: [{ eventdate: 20260916 }],
    players: [
      { playerid: 1, overallrating: 90, potential: 90, preferredposition1: 14, birthdate: 150444, finishing: 84, shortpassing: 93, trait1: 0, trait2: 0, icontrait1: 0, icontrait2: 0 },
      { playerid: 2, overallrating: 70, potential: 88, preferredposition1: 25, birthdate: 154841, finishing: 60, shortpassing: 55, trait1: 0, trait2: 0, icontrait1: 0, icontrait2: 0 },
    ],
    teamplayerlinks: [
      { teamid: CLUB, playerid: 1, jerseynumber: 8, position: 14, form: 3, injury: 0, leaguegoals: 9 },
      { teamid: CLUB, playerid: 2, jerseynumber: 9, position: 25, form: 4, injury: 0, leaguegoals: 3 },
    ],
    career_playergrowthuserseason: [{ playerid: 1, overall: 89, finishing: 83, shortpassing: 92 }],
    ...overrides,
  };
}

const build = (tables: Tables) =>
  buildViewDocument({ tables, resolver: createNameResolver(tables) });

describe('squad selection', () => {
  test('lists the club squad', () => {
    const doc = build(save());
    assert.equal(doc.senior.length, 2);
    assert.equal(doc.club.name, 'Manchester United');
  });

  test('keeps internationals in the squad', () => {
    // A player has one link row per squad, club *and* country. Keying on playerid
    // alone kept whichever came last and dropped nine Man Utd internationals.
    const tables = save();
    tables['teamplayerlinks'] = [
      ...tables['teamplayerlinks']!,
      { teamid: 1354, playerid: 1, jerseynumber: 8, position: 14, form: 3, injury: 0 },
    ];
    const doc = build(tables);
    assert.equal(doc.senior.length, 2, 'an international was dropped from the squad');
    assert.equal(doc.senior.find((p) => p.playerId === 1)?.nationalTeam, 1354);
    assert.equal(doc.senior.find((p) => p.playerId === 1)?.jersey, 8, 'club jersey was overwritten');
  });

  test('a player at another club is not in our squad', () => {
    const tables = save();
    tables['teamplayerlinks'] = [{ teamid: 999, playerid: 1, jerseynumber: 3, position: 5 }];
    assert.equal(build(tables).senior.length, 0);
  });
});

describe('academy selection', () => {
  const academy = (): Tables => {
    const tables = save();
    tables['players'] = [
      ...tables['players']!,
      { playerid: 460014, overallrating: 69, potential: 94, preferredposition1: 27, birthdate: 158000 },
      { playerid: 460095, overallrating: 69, potential: 79, preferredposition1: 3, birthdate: 158000 },
    ];
    tables['teamplayerlinks'] = [
      ...tables['teamplayerlinks']!,
      { teamid: YOUTH_TEAM_ID, playerid: 460014, jerseynumber: 40, position: 27 },
      { teamid: 189, playerid: 460095, jerseynumber: 29, position: 3 },
    ];
    tables['career_youthplayers'] = [
      { playerid: 460014, monthsinsquad: 5, playertier: 0, swinglowpotential: 1, potentialvariance: 5 },
      { playerid: 460095, monthsinsquad: 1, playertier: 3, swinglowpotential: 21, potentialvariance: 7 },
      { playerid: 459968, monthsinsquad: 2, playertier: 2, swinglowpotential: -10, potentialvariance: 0 },
    ];
    return tables;
  };

  test('shows only players actually in the academy squad', () => {
    const doc = build(academy());
    assert.deepEqual(doc.academy.map((p) => p.playerId), [460014]);
  });

  test('a former academy player now at another club appears nowhere', () => {
    // He is not ours any more, so he is not in either list — and that is not
    // worth a warning banner either.
    const doc = build(academy());
    assert.equal(doc.academy.some((p) => p.playerId === 460095), false);
    assert.equal(doc.senior.some((p) => p.playerId === 460095), false);
  });

  test('a youth row with no player record is not a prospect', () => {
    const doc = build(academy());
    assert.equal(doc.academy.some((p) => p.playerId === 459968), false);
  });

  test('carries the youth scouting fields', () => {
    const prospect = build(academy()).academy[0]!;
    assert.deepEqual(prospect.youth, {
      monthsInSquad: 5,
      tier: 0,
      potentialLow: 1,
      potentialVariance: 5,
    });
  });
});

describe('season growth', () => {
  test('reports the change since the season baseline', () => {
    const player = build(save()).senior.find((p) => p.playerId === 1)!;
    assert.equal(player.overallSeasonDelta, 1); // 90 now, 89 at season start

    const shooting = player.groups.find((g) => g.name === 'Shooting')!;
    const finishing = shooting.attributes.find((a) => a.name === 'finishing')!;
    assert.equal(finishing.value, 84);
    assert.equal(finishing.seasonDelta, 1);
  });

  test('a player with no baseline has unknown growth, not zero', () => {
    const player = build(save()).senior.find((p) => p.playerId === 2)!;
    assert.equal(player.overallSeasonDelta, null);
    const shooting = player.groups.find((g) => g.name === 'Shooting')!;
    assert.equal(shooting.attributes.find((a) => a.name === 'finishing')!.seasonDelta, null);
  });

  test('goalkeepers get goalkeeper groups', () => {
    const tables = save();
    tables['players'] = [{ playerid: 3, overallrating: 87, potential: 88, preferredposition1: 0, gkdiving: 85, gkreflexes: 89 }];
    tables['teamplayerlinks'] = [{ teamid: CLUB, playerid: 3, jerseynumber: 1, position: 0 }];
    const groups = build(tables).senior[0]!.groups.map((g) => g.name);
    assert.deepEqual(groups, ['Diving', 'Handling', 'Kicking', 'Reflexes', 'Speed', 'Positioning']);
  });
});

describe('derived values are labelled, not asserted', () => {
  test('the in-game date is always flagged as an estimate', () => {
    const doc = build(save());
    assert.equal(doc.gameDate, 20260916);
    assert.equal(doc.gameDateBasis, 'persistent_events.eventdate');
    assert.equal(doc.gameDateIsEstimate, true);
  });

  test('age is computed against the in-game date, not the wall clock', () => {
    // birthdate 150444 is 1994-09-08; at 2026-09-16 that is 32.
    assert.equal(dateFromDays(150444), '1994-09-08');
    assert.equal(ageAt(150444, 20260916), 32);
    assert.equal(ageAt(150444, 20260901), 31, 'birthday not yet reached');
  });

  test('age is unknown when the date is unknown, never a default', () => {
    assert.equal(ageAt(150444, null), null);
    assert.equal(ageAt(null, 20260916), null);
  });

  test('potential tags are labels with fixed cutoffs', () => {
    assert.equal(potentialTag(94), 'Special');
    assert.equal(potentialTag(88), 'Exciting');
    assert.equal(potentialTag(82), 'Great');
    assert.equal(potentialTag(70), null);
    assert.equal(potentialTag(null), null);
  });
});

describe('PlayStyles', () => {
  test('decodes the real Bruno Fernandes bitmask', () => {
    // trait1 11656, icontrait1 2^26. The live save agrees with the imported
    // trait list for this player, which is what validated the map (§2.6a).
    const styles = readPlayStyles({ trait1: 11656, trait2: 0, icontrait1: 1 << 26, icontrait2: 0 });
    const names = styles.map((s) => s.name).sort();
    assert.deepEqual(names, [
      'Dead Ball',
      'Gamechanger',
      'Incisive Pass',
      'Inventive',
      'Long Ball Pass',
      'Relentless',
      'Tiki Taka',
    ]);
    assert.equal(styles.find((s) => s.name === 'Relentless')?.plus, true);
    assert.equal(styles.find((s) => s.name === 'Tiki Taka')?.plus, false);
  });

  test('decodes goalkeeper PlayStyles from trait2', () => {
    const styles = readPlayStyles({ trait1: 0, trait2: 0b000111, icontrait1: 0, icontrait2: 0 });
    assert.deepEqual(styles.map((s) => s.name), ['Cross Claimer', 'Far Throw', 'Footwork']);
    assert.equal(styles[0]!.category, 'Goalkeeping');
  });

  test('trait2 bits above the goalkeeper range are not invented', () => {
    // Bits 8+ voted at 18-29% during derivation: noise, not PlayStyles.
    assert.deepEqual(readPlayStyles({ trait1: 0, trait2: 1 << 11, icontrait1: 0, icontrait2: 0 }), []);
  });

  test('an unmapped trait1 bit shows as a bit, never as a guessed name', () => {
    const styles = readPlayStyles({ trait1: 1 << 31, trait2: 0, icontrait1: 0, icontrait2: 0 });
    assert.deepEqual(styles.map((s) => s.name), ['bit 31']);
    assert.equal(styles[0]!.category, 'Unmapped');
  });

  test('no PlayStyles is an empty list, not a placeholder', () => {
    assert.deepEqual(readPlayStyles({ trait1: 0, trait2: 0, icontrait1: 0, icontrait2: 0 }), []);
  });
});
