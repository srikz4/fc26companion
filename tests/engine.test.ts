import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fitFor, allFits, slotOf, UNFAMILIAR_PENALTY } from '../src/engine/fit.ts';
import { evaluate, alertRail, THRESHOLDS, ceilingDriftEnabled, type RuleInput } from '../src/engine/rules.ts';
import { buildSynergy, channelsBetween, dutyCoverage, profileOf, targetSynergy, DUTY_UNITS } from '../src/engine/synergy.ts';
import { buildWageReport, contractMonths } from '../src/engine/wages.ts';
import { readFormations, pickXI, candidateFrom, readSavedXI, diffSelection } from '../src/engine/formations.ts';
import { depthGaps, eligibleClubs, affinityIndex } from '../src/engine/transfers.ts';
import { buildRegenReport, isNewgen, NEWGEN_ID_FLOOR } from '../src/engine/regens.ts';
import type { Row } from '../src/parser/dbReader.ts';

const outfield = (over: Partial<Row> = {}): Row => ({
  playerid: 1,
  overallrating: 80,
  potential: 85,
  preferredposition1: 14,
  acceleration: 70, sprintspeed: 70, agility: 70, balance: 70, reactions: 80,
  ballcontrol: 80, dribbling: 78, positioning: 70, finishing: 65, shotpower: 75,
  longshots: 70, volleys: 60, penalties: 65, vision: 82, crossing: 70,
  freekickaccuracy: 65, shortpassing: 84, longpassing: 80, curve: 70,
  interceptions: 72, headingaccuracy: 60, defensiveawareness: 70,
  standingtackle: 72, slidingtackle: 68, jumping: 70, stamina: 85,
  strength: 72, aggression: 70, composure: 80,
  trait1: 0, trait2: 0, icontrait1: 0, icontrait2: 0,
  ...over,
});

describe('position fit', () => {
  test('maps game position codes to slots', () => {
    assert.equal(slotOf(0), 'GK');
    assert.equal(slotOf(14), 'CM');
    assert.equal(slotOf(25), 'ST');
    assert.equal(slotOf(null), null);
  });

  test('penalises a slot the player does not play', () => {
    const player = outfield({ preferredposition1: 14 });
    const cm = fitFor(player, 'CM')!;
    const st = fitFor(player, 'ST')!;
    assert.equal(cm.familiar, true);
    assert.equal(st.familiar, false);
    // Same attributes, so the only difference at equal weighting is the penalty.
    const stNoPenalty = st.value + UNFAMILIAR_PENALTY;
    assert.ok(stNoPenalty > st.value);
  });

  test('a goalkeeper has no outfield fit and vice versa', () => {
    const keeper: Row = {
      playerid: 2, overallrating: 85, potential: 88, preferredposition1: 0,
      gkdiving: 85, gkreflexes: 86, gkpositioning: 84, gkhandling: 83, gkkicking: 78, composure: 80,
    };
    assert.ok(fitFor(keeper, 'GK'));
    assert.equal(fitFor(keeper, 'ST'), null, 'a keeper scored as a striker');
    assert.equal(fitFor(outfield(), 'GK'), null, 'an outfielder scored as a keeper');
  });

  test('fits come back sorted, best first', () => {
    const fits = allFits(outfield());
    for (let i = 1; i < fits.length; i++) assert.ok(fits[i - 1]!.value >= fits[i]!.value);
  });
});

describe('rules', () => {
  const base: RuleInput = {
    playerId: 1, name: 'Test', age: 25, overall: 80, potential: 85, headroom: 5,
    minutesPct: 50, overallSeasonDelta: 0, ceilingDriftSeason: null, contractMonths: 36,
    squad: 'senior', reposition: null, blocking: null, blockedBy: null,
    depthRank: 1, depthRankTwoPotential: null, injured: false, retiring: false, selectionCost: null,
  };

  test('every player gets exactly one line', () => {
    const r = evaluate(base);
    assert.equal(r.primary.rule, 'R-99');
    assert.equal(r.primary.severity, 'steady');
  });

  test('a starved prospect fires R-03 with its numbers', () => {
    const r = evaluate({ ...base, age: 19, minutesPct: 5, headroom: 12 });
    assert.equal(r.primary.rule, 'R-03');
    assert.match(r.primary.evidence, /5%/);
    assert.match(r.primary.evidence, /growth left 12/);
  });

  test('the highest priority wins and the rest are kept', () => {
    const r = evaluate({
      ...base, age: 19, minutesPct: 5, headroom: 12,
      reposition: { from: 'CM', to: 'CAM', gain: 5 },
    });
    assert.equal(r.primary.rule, 'R-03');
    assert.ok(r.others.some((a) => a.rule === 'R-10'));
  });

  test('a rule does not fire on unknown input', () => {
    // Age unknown: the starved rule must stay silent rather than assume young.
    const r = evaluate({ ...base, age: null, minutesPct: 5, headroom: 12 });
    assert.equal(r.primary.rule, 'R-99');
  });

  test('ceiling-drift rules are live (A-3 proven 2026-08-28) and fire both ways', () => {
    assert.equal(ceilingDriftEnabled, true);
    const falling = evaluate({ ...base, age: 19, ceilingDriftSeason: -5 });
    assert.equal(falling.primary.rule, 'R-01');
    const rising = evaluate({ ...base, ceilingDriftSeason: 3 });
    assert.ok([rising.primary, ...rising.others].some((a) => a.rule === 'R-09'));
    const unknown = evaluate({ ...base, age: 19, ceilingDriftSeason: null });
    assert.notEqual(unknown.primary.rule, 'R-01');
  });

  test('thresholds live in one place', () => {
    assert.equal(THRESHOLDS.starvedMinutesPct, 25);
    const justUnder = evaluate({ ...base, age: 20, minutesPct: 24, headroom: 10 });
    const justOver = evaluate({ ...base, age: 20, minutesPct: 26, headroom: 10 });
    assert.equal(justUnder.primary.rule, 'R-03');
    assert.notEqual(justOver.primary.rule, 'R-03');
  });

  test('the alert rail drops steady lines and sorts by severity', () => {
    const rail = alertRail([
      { input: base, result: evaluate(base) },
      { input: { ...base, age: 19, minutesPct: 5, headroom: 12 }, result: evaluate({ ...base, age: 19, minutesPct: 5, headroom: 12 }) },
    ]);
    assert.ok(rail.length > 0);
    assert.ok(!rail.some((a) => a.severity === 'steady'), 'steady leaked into the rail');
    assert.equal(rail[0]!.severity, 'action');
  });
});

describe('synergy', () => {
  const nameless = (over: Partial<Row> = {}) => outfield(over);

  test('a crosser and a header connect, and the strength is the geometric mean', () => {
    const winger = nameless({ playerid: 1, preferredposition1: 23, crossing: 90, curve: 90 });
    const striker = nameless({ playerid: 2, preferredposition1: 25, headingaccuracy: 90, jumping: 90, positioning: 90 });
    const link = channelsBetween(profileOf(winger), profileOf(striker)).find((l) => l.channelId === 'CH-CROSS');
    assert.ok(link, 'cross channel did not fire');
    assert.equal(link.supplier, 1);
    assert.equal(link.receiver, 2);
    assert.equal(link.supplierScore, 90);
    assert.equal(link.receiverScore, 90);
    assert.equal(link.strength, 90);
  });

  test('a channel is only as strong as its weak end', () => {
    const greatCrosser = nameless({ playerid: 1, preferredposition1: 23, crossing: 95, curve: 95 });
    const poorHeader = nameless({ playerid: 2, preferredposition1: 25, headingaccuracy: 50, jumping: 50, positioning: 50 });
    const link = channelsBetween(profileOf(greatCrosser), profileOf(poorHeader)).find((l) => l.channelId === 'CH-CROSS');
    assert.ok(link);
    // √(95×50) ≈ 68.9 — well below the arithmetic mean of 72.5.
    assert.ok(link.strength <= 69, `strength ${link.strength} did not punish the imbalance`);
  });

  test('PlayStyles amplify, visibly and modestly', () => {
    const base = { playerid: 1, preferredposition1: 23, crossing: 85, curve: 85 };
    const striker = nameless({ playerid: 2, preferredposition1: 25, headingaccuracy: 85, jumping: 85, positioning: 85 });
    const plain = channelsBetween(profileOf(nameless(base)), profileOf(striker)).find((l) => l.channelId === 'CH-CROSS');
    // bit 12 is Whipped Pass.
    const styled = channelsBetween(profileOf(nameless({ ...base, trait1: 1 << 12 })), profileOf(striker)).find(
      (l) => l.channelId === 'CH-CROSS',
    );
    assert.ok(plain && styled);
    assert.equal(styled.strength - plain.strength, 3);
    assert.deepEqual(styled.amplifiedBy, ['Whipped Pass']);
  });

  test('slot gates hold at both ends', () => {
    // A centre-back with elite crossing at a keeper with elite heading: no channel.
    const cb = nameless({ playerid: 1, preferredposition1: 5, crossing: 95, curve: 95 });
    const gk = { playerid: 2, preferredposition1: 0, headingaccuracy: 95, jumping: 95, positioning: 95 };
    const links = channelsBetween(profileOf(cb), profileOf(gk)).filter((l) => l.channelId === 'CH-CROSS');
    assert.equal(links.length, 0);
  });

  test('nationality and former clubs are gone from the model', () => {
    // Same nation, and imagine the same former club: nothing fires on it.
    const a = nameless({ playerid: 1, preferredposition1: 14, nationality: 21 });
    const b = nameless({ playerid: 2, preferredposition1: 14, nationality: 21 });
    for (const link of channelsBetween(profileOf(a), profileOf(b))) {
      assert.ok(!/nation|club/i.test(link.channel), `trivia leaked in: ${link.channel}`);
    }
  });

  test('a centre-back pair is scored on coverage, and the gain is the point', () => {
    const aerial = nameless({
      playerid: 1, preferredposition1: 5,
      headingaccuracy: 90, jumping: 88, strength: 90,
      sprintspeed: 55, acceleration: 55,
      interceptions: 75, defensiveawareness: 78,
      shortpassing: 60, ballcontrol: 58, composure: 65,
    });
    const rapid = nameless({
      playerid: 2, preferredposition1: 5,
      headingaccuracy: 60, jumping: 62, strength: 62,
      sprintspeed: 90, acceleration: 90,
      interceptions: 74, defensiveawareness: 76,
      shortpassing: 78, ballcontrol: 76, composure: 78,
    });
    const unit = DUTY_UNITS.find((u) => u.id === 'DU-CB')!;
    const cover = dutyCoverage(unit, profileOf(aerial), profileOf(rapid));
    assert.ok(cover);
    assert.ok(cover.gain > 5, `complementary pair gained only ${cover.gain}`);
    const aerialDuty = cover.perDuty.find((d) => d.duty === 'Aerial')!;
    const paceDuty = cover.perDuty.find((d) => d.duty === 'Recovery pace')!;
    assert.equal(aerialDuty.carrier, 1);
    assert.equal(paceDuty.carrier, 2);
  });

  test('two copies of the same player cover nothing extra', () => {
    const a = nameless({ playerid: 1, preferredposition1: 5, headingaccuracy: 80, jumping: 80, strength: 80, sprintspeed: 70, acceleration: 70 });
    const b = nameless({ ...a, playerid: 2 });
    const unit = DUTY_UNITS.find((u) => u.id === 'DU-CB')!;
    const cover = dutyCoverage(unit, profileOf(a), profileOf(b));
    assert.ok(cover);
    assert.equal(cover.gain, 0);
  });

  test('buildSynergy ranks partnerships and never emits below the floor', () => {
    const squad = [
      nameless({ playerid: 1, preferredposition1: 23, crossing: 92, curve: 90 }),
      nameless({ playerid: 2, preferredposition1: 25, headingaccuracy: 91, jumping: 90, positioning: 88 }),
      nameless({ playerid: 3, preferredposition1: 14, vision: 40, shortpassing: 40, longpassing: 40 }),
    ];
    const report = buildSynergy(squad, null);
    assert.ok(report.partnerships.length >= 1);
    assert.equal(report.partnerships[0]!.channelId, 'CH-CROSS');
    for (const link of report.partnerships) assert.ok(link.strength >= 55);
  });

  test('a transfer target reports what he adds over the incumbent pattern', () => {
    const squad = [
      nameless({ playerid: 1, preferredposition1: 23, crossing: 70, curve: 70 }),
      nameless({ playerid: 2, preferredposition1: 25, headingaccuracy: 90, jumping: 90, positioning: 90 }),
    ];
    const report = buildSynergy(squad, null);
    const eliteCrosser = nameless({ playerid: 99, preferredposition1: 23, crossing: 94, curve: 94 });
    const syn = targetSynergy(eliteCrosser, squad, report);
    assert.ok(syn.best[0]);
    assert.equal(syn.best[0].channelId, 'CH-CROSS');
    assert.ok(syn.gainOverIncumbent !== null && syn.gainOverIncumbent > 0,
      `an obvious upgrade reported gain ${syn.gainOverIncumbent}`);
  });
});

describe('wages', () => {
  test('compares a player against his own role band', () => {
    const report = buildWageReport([
      { playerId: 1, wage: 100_000, roleCode: 1, age: 28, headroom: 0, contractMonths: 24 },
      { playerId: 2, wage: 110_000, roleCode: 1, age: 27, headroom: 0, contractMonths: 24 },
      { playerId: 3, wage: 20_000, roleCode: 1, age: 22, headroom: 8, contractMonths: 24 },
      { playerId: 4, wage: 15_000, roleCode: 3, age: 24, headroom: 3, contractMonths: 24 },
    ]);
    // Band median over all three crucial players is 100,000.
    assert.equal(report.assessments.get(3)!.verdict, 'under');
    assert.equal(report.assessments.get(1)!.verdict, 'in-line');
    assert.equal(report.assessments.get(2)!.verdict, 'in-line');
    assert.equal(report.totalBill, 245_000);
  });

  test('too few peers means unknown, not a verdict', () => {
    const report = buildWageReport([
      { playerId: 1, wage: 100_000, roleCode: 1, age: 28, headroom: 0, contractMonths: 24 },
      { playerId: 2, wage: 10_000, roleCode: 5, age: 18, headroom: 20, contractMonths: 24 },
    ]);
    assert.equal(report.assessments.get(2)!.verdict, 'unknown');
  });

  test('contract months are computed against the in-game date', () => {
    assert.equal(contractMonths(2030, 20260916), (2030 - 2026) * 12 + (6 - 9));
    assert.equal(contractMonths(null, 20260916), null);
    assert.equal(contractMonths(2030, null), null);
  });

  test('the board budget is never reported as zero', () => {
    // career_managerpref reads 0 in this save, which is not the same as no money.
    assert.equal(buildWageReport([]).budgetKnown, false);
  });
});

describe('formations and selection', () => {
  const formationRow = (name: string, positions: number[]): Row => {
    const row: Row = { formationname: name, formationid: 1 };
    positions.forEach((p, i) => {
      row[`position${i}`] = p;
    });
    return row;
  };

  const shape = formationRow('4-3-3', [0, 3, 5, 5, 7, 14, 14, 14, 23, 25, 27]);

  test('shapes come from the save, never invented', () => {
    const shapes = readFormations([shape, { formationname: 'not a shape' }]);
    assert.equal(shapes.length, 1);
    assert.equal(shapes[0]!.name, '4-3-3');
  });

  test('picks an XI deterministically', () => {
    const squad = Array.from({ length: 14 }, (_, i) =>
      candidateFrom(outfield({ playerid: i + 1, overallrating: 70 + i, preferredposition1: [0, 3, 5, 5, 7, 14, 14, 14, 23, 25, 27, 14, 5, 25][i]!, gkdiving: 80, gkreflexes: 80, gkpositioning: 80, gkhandling: 80, gkkicking: 80 }), true),
    ).filter((c): c is NonNullable<typeof c> => c !== null);

    const first = pickXI(readFormations([shape])[0]!, squad);
    const second = pickXI(readFormations([shape])[0]!, squad);
    assert.deepEqual(
      first.assignments.map((a) => a.playerId),
      second.assignments.map((a) => a.playerId),
      'the same squad produced two different elevens',
    );
    assert.ok(first.today !== null);
    assert.ok(first.growth !== null, 'growth must always accompany today');
  });

  test('an unavailable player is not selected', () => {
    const squad = [
      candidateFrom(outfield({ playerid: 1, overallrating: 90, preferredposition1: 25 }), false)!,
      candidateFrom(outfield({ playerid: 2, overallrating: 70, preferredposition1: 25 }), true)!,
    ];
    const xi = pickXI(readFormations([formationRow('1-0-0', [25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25])])[0] ?? readFormations([shape])[0]!, squad);
    assert.ok(!xi.assignments.some((a) => a.playerId === 1), 'an injured player was picked');
  });

  test('reads the saved XI and diffs it', () => {
    const mentalities: Row[] = [{ tactic_name: 'Mine', sourceformationid: 1 }];
    for (let i = 0; i < 11; i++) {
      mentalities[0]![`playerid${i}`] = i + 1;
      mentalities[0]![`position${i}`] = shape[`position${i}`] as number;
    }
    const saved = readSavedXI(mentalities, [{ captainid: 3 }]);
    assert.ok(saved);
    assert.equal(saved.tacticName, 'Mine');
    assert.equal(saved.players.length, 11);
    assert.equal(saved.captainId, 3);

    const squad = Array.from({ length: 11 }, (_, i) =>
      candidateFrom(outfield({ playerid: i + 1, preferredposition1: 14 }), true)!,
    );
    const diff = diffSelection(saved, pickXI(readFormations([shape])[0]!, squad), squad);
    assert.equal(diff.length, 11);
  });
});

describe('transfers', () => {
  test('wing-back is not counted as a depth requirement', () => {
    // The game rarely lists RWB/LWB as a primary position, so demanding natural
    // cover there reports a hole in every squad in the game.
    const gaps = depthGaps([outfield({ preferredposition1: 3 })]);
    assert.equal(gaps.some((g) => g.slot === 'WB'), false);
  });

  test('a slot with nobody natural is a gap', () => {
    const gaps = depthGaps([outfield({ playerid: 1, preferredposition1: 14 })]);
    assert.equal(gaps.find((g) => g.slot === 'GK')!.severity, 'gap');
    assert.match(gaps.find((g) => g.slot === 'GK')!.note, /Nobody/);
  });

  test('only clubs in a real domestic league are signable', () => {
    const eligible = eligibleClubs(
      [
        { teamid: 11, leagueid: 13 },
        { teamid: 900, leagueid: 78 },
        { teamid: 901, leagueid: 79 },
      ],
      [
        { leagueid: 13, iswomencompetition: 0, isinternationalleague: 0 },
        { leagueid: 78, iswomencompetition: 1, isinternationalleague: 0 },
        { leagueid: 79, iswomencompetition: 0, isinternationalleague: 1 },
      ],
    );
    assert.deepEqual([...eligible], [11]);
  });

  test('affinity reads grudge/love at level 6 and above', () => {
    const index = affinityIndex([
      { playerid: 1, emotional_teamid: 237, level_of_emotion: 7 },
      { playerid: 2, emotional_teamid: 11, level_of_emotion: 1 },
    ]);
    assert.ok(index.get(1)?.has(237));
    assert.equal(index.has(2), false);
  });
});

describe('regens', () => {
  test('detects newgens structurally, not by guessing', () => {
    assert.equal(isNewgen(212198), false);
    assert.equal(isNewgen(460027), true);
    assert.equal(isNewgen(NEWGEN_ID_FLOOR), true);
  });

  const report = (tags: Map<number, never[]>) =>
    buildRegenReport({
      players: new Map<number, Row>([
        [460001, outfield({ playerid: 460001, overallrating: 60, potential: 90 })],
        [212198, outfield({ playerid: 212198 })],
      ]),
      links: new Map<number, Row>([
        [460001, { playerid: 460001, teamid: 112264 }],
        [212198, { playerid: 212198, teamid: 11 }],
      ]),
      teamNames: new Map([[112264, 'Academy'], [11, 'Man Utd']]),
      ourClubId: 11,
      youthTeamId: 112264,
      loanedIds: new Set(),
      gameDate: 20260916,
      nameOf: (id) => `P${id}`,
      ageOf: () => 17,
      tags,
    });

  test('tracks newgens at our club', () => {
    const r = report(new Map());
    assert.deepEqual(r.tracked.map((t) => t.playerId), [460001]);
    assert.equal(r.tracked[0]!.location, 'academy');
  });

  test('a tagged player is tracked even when he has left the save', () => {
    const r = report(new Map([[999999, []]]));
    const lost = r.tracked.find((t) => t.playerId === 999999);
    assert.ok(lost, 'a tagged player vanished from the tracker');
    assert.equal(lost.lostFromSave, true);
    assert.equal(lost.location, 'gone');
  });
});
