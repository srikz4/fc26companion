import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eaValue } from '../src/engine/eaValue.ts';

/** Position codes: 25 ST, 14 CM, 5 CB, 0 GK, 23 RW, 10 CDM, 7 LB, 18 CAM. */
const CROSS: { pos: number; age: number; ovr: number; pot: number; expect: number }[] = [
  { pos: 14, age: 17, ovr: 65, pot: 90, expect: 2_200_000 },
  { pos: 5, age: 19, ovr: 72, pot: 84, expect: 5_000_000 },
  { pos: 0, age: 29, ovr: 85, pot: 85, expect: 37_000_000 },
  { pos: 25, age: 33, ovr: 88, pot: 88, expect: 58_500_000 },
  { pos: 23, age: 21, ovr: 78, pot: 89, expect: 31_500_000 },
  { pos: 10, age: 26, ovr: 83, pot: 86, expect: 43_000_000 },
  { pos: 7, age: 36, ovr: 74, pot: 74, expect: 925_000 },
  { pos: 18, age: 16, ovr: 55, pot: 80, expect: 400_000 },
  { pos: 25, age: 24, ovr: 90, pot: 94, expect: 173_500_000 },
  { pos: 5, age: 31, ovr: 80, pot: 80, expect: 14_500_000 },
  { pos: 14, age: 27, ovr: 92, pot: 92, expect: 156_000_000 },
  { pos: 25, age: 28, ovr: 70, pot: 75, expect: 2_200_000 },
  { pos: 25, age: 27, ovr: 75, pot: 84, expect: 12_000_000 },
  { pos: 25, age: 17, ovr: 65, pot: 85, expect: 1_900_000 },
];

describe('eaValue', () => {
  test('reproduces held-out sampled values within the honest band', () => {
    const errors = CROSS.map((c) => {
      const got = eaValue(c.ovr, c.age, c.pot, c.pos);
      assert.ok(got, `no value for ${JSON.stringify(c)}`);
      return Math.abs(got!.value - c.expect) / c.expect;
    });
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    // The curves are sampled and refit; the claim is a guide, not a ledger.
    assert.ok(mean < 0.12, `mean relative error ${(mean * 100).toFixed(1)}% too high`);
    for (let i = 0; i < errors.length; i++) {
      assert.ok(errors[i]! < 0.5, `sample ${i} off by ${(errors[i]! * 100).toFixed(0)}%: ${JSON.stringify(CROSS[i])}`);
    }
  });

  test('band brackets the value and nulls stay null', () => {
    const v = eaValue(80, 24, 85, 25)!;
    assert.ok(v.floor < v.value && v.value < v.ceiling);
    assert.equal(eaValue(null, 24, 85, 25), null);
    assert.equal(eaValue(80, null, 85, 25), null);
  });

  test('a veteran with no headroom is worth a fraction of his peak self', () => {
    const peak = eaValue(80, 24, 80, 25)!.value;
    const vet = eaValue(80, 36, 80, 25)!.value;
    assert.ok(vet < peak * 0.4);
  });
});
