import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, mapDealType, mapAssetType, mapExperience, mapExperienceCount,
  mapExitStrategy, deriveDealCategory, scoreBand,
  estimateCollateral, estimateCashFlow, estimateBorrower, estimateExecution,
  buildRiskFlags,
} from './deal-mappers.mjs';

const DEAL_TYPE_ENUM = ['fix_flip', 'rental', 'cash_out', 'bridge', 'construction', 'commercial'];
const ASSET_TYPE_ENUM = ['sfr', '2_4_unit', 'multifamily', 'commercial', 'mixed_use', 'land'];
const EXP_ENUM = ['first_time', 'emerging', 'experienced', 'veteran'];
const BAND_ENUM = ['strong', 'conditional', 'hold'];

test('clamp bounds', () => {
  assert.equal(clamp(150, 0, 100), 100);
  assert.equal(clamp(-5, 0, 100), 0);
  assert.equal(clamp(42, 0, 100), 42);
});

test('mapDealType residential values and stays in enum', () => {
  assert.equal(mapDealType('Fix & Flip'), 'fix_flip');
  assert.equal(mapDealType('New Construction'), 'construction');
  assert.equal(mapDealType('Rental'), 'rental');
  assert.equal(mapDealType('Cash-Out'), 'cash_out');
  assert.equal(mapDealType('Bridge'), 'bridge');
  for (const v of ['', 'conventional', 'anything', undefined]) {
    assert.ok(DEAL_TYPE_ENUM.includes(mapDealType(v)), `${v} -> ${mapDealType(v)}`);
  }
});

test('mapDealType commercial pill values (Acquisition/Refinance/Bridge/Construction/Cash-Out)', () => {
  assert.equal(mapDealType('Acquisition', 'Commercial'), 'commercial');
  assert.equal(mapDealType('Refinance', 'Commercial'), 'commercial');
  assert.equal(mapDealType('Bridge', 'Commercial'), 'bridge');
  assert.equal(mapDealType('Construction', 'Commercial'), 'construction');
  assert.equal(mapDealType('Cash-Out', 'Commercial'), 'cash_out');
  for (const v of ['Acquisition', 'Refinance', 'Bridge', 'Construction', 'Cash-Out', '', undefined]) {
    assert.ok(DEAL_TYPE_ENUM.includes(mapDealType(v, 'Commercial')), `${v} -> ${mapDealType(v, 'Commercial')}`);
  }
  // market casing-insensitive
  assert.equal(mapDealType('Acquisition', 'commercial'), 'commercial');
});

test('mapAssetType residential values and stays in enum', () => {
  assert.equal(mapAssetType('SFR'), 'sfr');
  assert.equal(mapAssetType('Condo'), 'sfr');
  assert.equal(mapAssetType('2-4 Unit'), '2_4_unit');
  assert.equal(mapAssetType('Multifamily 5+'), 'multifamily');
  assert.equal(mapAssetType('Commercial'), 'commercial');
  assert.equal(mapAssetType('Land'), 'land');
  for (const v of ['', 'weird', undefined]) {
    assert.ok(ASSET_TYPE_ENUM.includes(mapAssetType(v)));
  }
});

test('mapAssetType commercial pill values (Office/Retail/Industrial/Mixed Use/Self Storage/Multifamily)', () => {
  assert.equal(mapAssetType('Office', 'Commercial'), 'commercial');
  assert.equal(mapAssetType('Retail', 'Commercial'), 'commercial');
  assert.equal(mapAssetType('Industrial', 'Commercial'), 'commercial');
  assert.equal(mapAssetType('Self Storage', 'Commercial'), 'commercial');
  assert.equal(mapAssetType('Mixed Use', 'Commercial'), 'mixed_use');
  assert.equal(mapAssetType('Multifamily 5+', 'Commercial'), 'multifamily');
  for (const v of ['Office', 'Retail', 'Industrial', 'Mixed Use', 'Self Storage', 'Multifamily 5+', '', undefined]) {
    assert.ok(ASSET_TYPE_ENUM.includes(mapAssetType(v, 'Commercial')), `${v} -> ${mapAssetType(v, 'Commercial')}`);
  }
});

test('mapExperience / mapExperienceCount', () => {
  assert.equal(mapExperience('First-time investor'), 'first_time');
  assert.equal(mapExperience('1-3 deals'), 'emerging');
  assert.equal(mapExperience('4-10 deals'), 'experienced');
  assert.equal(mapExperience('20+ deals'), 'veteran');
  assert.equal(mapExperience(undefined), 'first_time');
  for (const v of ['', 'x', undefined]) assert.ok(EXP_ENUM.includes(mapExperience(v)));
  assert.equal(mapExperienceCount('First-time'), 0);
  assert.equal(mapExperienceCount('1-3'), 2);
  assert.equal(mapExperienceCount('4-10'), 7);
  assert.equal(mapExperienceCount('10-20'), 15);
  assert.equal(mapExperienceCount('25 deals veteran'), 25);
  assert.equal(mapExperienceCount(undefined), 0);
});

test('mapExitStrategy default and known', () => {
  assert.equal(mapExitStrategy('Fix & Flip'), 'flip');
  assert.equal(mapExitStrategy('Rental'), 'hold');
  assert.equal(mapExitStrategy('Cash-Out'), 'refinance');
  assert.equal(mapExitStrategy(undefined), 'hold');
  // commercial branch
  assert.equal(mapExitStrategy('Refinance', 'Commercial'), 'refinance');
  assert.equal(mapExitStrategy('Construction', 'Commercial'), 'sell');
  assert.equal(mapExitStrategy('Acquisition', 'Commercial'), 'hold');
  assert.equal(mapExitStrategy(undefined, 'Commercial'), 'hold');
});

test('deriveDealCategory reads the RAW form value', () => {
  assert.equal(deriveDealCategory('conventional'), 'qm');
  assert.equal(deriveDealCategory('FHA'), 'qm');
  assert.equal(deriveDealCategory('va'), 'qm');
  assert.equal(deriveDealCategory('Fix & Flip'), 'non_qm');
  assert.equal(deriveDealCategory(''), 'non_qm');
  assert.equal(deriveDealCategory(undefined), 'non_qm');
});

test('scoreBand thresholds', () => {
  assert.equal(scoreBand(80), 'strong');
  assert.equal(scoreBand(65), 'strong');
  assert.equal(scoreBand(64), 'conditional');
  assert.equal(scoreBand(45), 'conditional');
  assert.equal(scoreBand(44), 'hold');
  assert.equal(scoreBand(0), 'hold');
  for (const s of [0, 44, 45, 64, 65, 100]) assert.ok(BAND_ENUM.includes(scoreBand(s)));
});

test('estimators stay within 0-100 for garbage input', () => {
  const cases = [
    {}, { ltv: '999', dscr: '-3', creditScore: '20', investorExperience: '' },
    { ltv: '60', dscr: '2.0', creditScore: '800', investorExperience: '20+ deals', arv: '1', rehabBudget: '1' },
  ];
  for (const d of cases) {
    for (const fn of [estimateCollateral, estimateCashFlow, estimateBorrower, estimateExecution]) {
      const v = fn(d);
      assert.ok(v >= 0 && v <= 100, `${fn.name}(${JSON.stringify(d)}) = ${v}`);
    }
  }
});

test('buildRiskFlags returns an array of flag objects', () => {
  const flags = buildRiskFlags({ ltv: '95', dscr: '0.8', creditScore: '600' }, { humanReviewRequired: true });
  assert.ok(Array.isArray(flags));
  assert.ok(flags.every((f) => typeof f.flag === 'string' && typeof f.severity === 'string'));
  assert.ok(flags.some((f) => f.flag === 'high_ltv'));
  assert.ok(flags.some((f) => f.flag === 'dscr_below_threshold'));
  assert.ok(flags.some((f) => f.flag === 'low_credit'));
  assert.deepEqual(buildRiskFlags({}, {}), []);
});
