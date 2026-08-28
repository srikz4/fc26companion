import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  agePercentile,
  attributePercentile,
  buildWorldStats,
  percentileOf,
  profileSimilarity,
  standoutAttributes,
  zProfile,
} from '../src/engine/percentiles.ts';
import type { Row } from '../src/parser/dbReader.ts';

/** A synthetic world: 500 centre-mids whose vision runs 40..90 uniformly. */
function world(): Row[] {
  const players: Row[] = [];
  for (let i = 0; i < 500; i++) {
    players.push({
      playerid: 1000 + i,
      preferredposition1: 14,
      birthdate: 150000, // all the same age for the age-bucket tests
      overallrating: 50 + (i % 40),
      potential: 60 + (i % 35),
      vision: 40 + (i % 51),
      shortpassing: 60,
      ballcontrol: 60,
      stamina: 60,
      composure: 60,
      dribbling: 60,
      longpassing: 60,
      interceptions: 60,
      reactions: 60,
      agility: 60,
      positioning: 60,
      finishing: 60,
    });
  }
  return players;
}

const ageOf = () => 24;

describe('percentileOf', () => {
  const sorted = Float64Array.from([10, 20, 30, 40, 50]);

  test('is the share of the population at or below the value', () => {
    assert.equal(percentileOf(sorted, 30), 60);
    assert.equal(percentileOf(sorted, 50), 100);
    assert.equal(percentileOf(sorted, 5), 0);
  });
});

describe('world statistics', () => {
  const stats = buildWorldStats(world(), ageOf);

  test('a middling value ranks near the middle of its position', () => {
    const pct = attributePercentile(stats, 'CM', 'vision', 65);
    assert.ok(pct !== null && pct > 40 && pct < 62, `vision 65 ranked ${pct}`);
  });

  test('an elite value ranks at the top', () => {
    const pct = attributePercentile(stats, 'CM', 'vision', 90);
    assert.equal(pct, 100);
  });

  test('a thin population refuses to rank rather than mislead', () => {
    // No strikers in this world at all.
    assert.equal(attributePercentile(stats, 'ST', 'finishing', 90), null);
  });

  test('standout attributes are the ones above the bar, capped', () => {
    const player: Row = { playerid: 1, preferredposition1: 14, vision: 90, shortpassing: 60 };
    const out = standoutAttributes(stats, 'CM', player);
    assert.ok(out.some((s) => s.attr === 'vision' && s.percentile >= 90));
    assert.ok(out.length <= 3);
  });

  test('age percentile places a player against his generation', () => {
    const at = agePercentile(stats, 24, 89, 94);
    assert.ok(at);
    assert.equal(at.overall, 100);
    assert.equal(at.potential, 100);
    assert.ok(at.peers >= 500);
  });

  test('an age nobody has returns null, not a made-up rank', () => {
    assert.equal(agePercentile(stats, 55, 80, 85), null);
  });
});

describe('profile similarity', () => {
  const stats = buildWorldStats(world(), ageOf);

  test('identical profiles read as identical shapes', () => {
    const player: Row = {
      playerid: 1, preferredposition1: 14,
      vision: 80, shortpassing: 70, ballcontrol: 65, stamina: 62, composure: 61,
      dribbling: 60, longpassing: 72, interceptions: 55, reactions: 66, agility: 63,
      positioning: 58, finishing: 45,
    };
    const a = zProfile(stats, 'CM', player);
    const b = zProfile(stats, 'CM', { ...player, playerid: 2 });
    assert.ok(a && b);
    const sim = profileSimilarity(a, b);
    assert.ok(sim !== null && sim > 0.999);
  });

  test('opposite profiles read as different shapes', () => {
    const passer: Row = {
      playerid: 1, preferredposition1: 14,
      vision: 90, shortpassing: 88, longpassing: 86, ballcontrol: 80, composure: 78,
      stamina: 50, interceptions: 40, reactions: 60, agility: 55, dribbling: 62,
      positioning: 58, finishing: 45,
    };
    const runner: Row = {
      playerid: 2, preferredposition1: 14,
      vision: 45, shortpassing: 52, longpassing: 44, ballcontrol: 55, composure: 50,
      stamina: 92, interceptions: 85, reactions: 70, agility: 75, dribbling: 58,
      positioning: 66, finishing: 60,
    };
    const a = zProfile(stats, 'CM', passer);
    const b = zProfile(stats, 'CM', runner);
    assert.ok(a && b);
    const sim = profileSimilarity(a, b);
    assert.ok(sim !== null && sim < 0.5, `opposites scored ${sim}`);
  });
});
