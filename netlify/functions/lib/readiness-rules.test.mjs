import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyPayment, computeMetrics, evaluateProgram, evaluateLender, normalizeLtv, screen, diffScreens,
  GUIDELINES_VERSION, CONFORMING_LIMIT, CONFORMING_LIMIT_HIGH_COST,
} from './readiness-rules.mjs';

// Expected values below were computed independently with Python Decimal (40 digits), not with this module.
const near = (actual, expected, tol = 0.001) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);
const byId = (res, id) => res.checks.find((c) => c.id === id);

// S1: $400k price, 20% down, 6.5% 30yr, taxes 400, insurance 150, no HOA, income 9000, debts 600
const S1 = {
  purchasePrice: 400000, loanAmount: 320000, rateAnnualPct: 6.5, monthlyTaxes: 400, monthlyInsurance: 150, monthlyHOA: 0,
  grossMonthlyIncome: 9000, monthlyDebts: 600, creditScore: 720, reservesMonths: 3, state: 'FL', assetType: 'sfr',
};
// S4: DSCR rental, $500k price, $375k loan, 7.5%, taxes 450, insurance 200, rent 3500
const S4 = {
  purchasePrice: 500000, loanAmount: 375000, rateAnnualPct: 7.5, monthlyTaxes: 450, monthlyInsurance: 200, monthlyHOA: 0,
  monthlyRent: 3500, creditScore: 700, reservesMonths: 4, state: 'FL', assetType: 'sfr',
};

test('monthlyPayment matches independently computed values', () => {
  near(monthlyPayment(320000, 6.5, 30), 2022.6177);
  near(monthlyPayment(375000, 7.5, 30), 2622.0544);
  assert.equal(monthlyPayment(120000, 0, 10), 1000);
  assert.equal(monthlyPayment(0, 6, 30), null);
  assert.equal(monthlyPayment(100000, null, 30), null);
});

test('no default rate: without a rate, payment and DTI are unknown and checks need input', () => {
  const { rateAnnualPct, ...noRate } = S1;
  const m = computeMetrics(noRate);
  assert.equal(m.monthlyPI, null);
  assert.equal(m.monthlyPITIA, null);
  assert.equal(m.frontEndDti, null);
  const conv = evaluateProgram('conventional', noRate);
  assert.equal(byId(conv, 'front_dti').status, 'needs_input');
  assert.equal(byId(conv, 'back_dti').status, 'needs_input');
  assert.equal(conv.overall, 'incomplete');
});

test('scenario 1: conventional fails front-end DTI at 28.58 while back-end and FHA pass', () => {
  const m = computeMetrics(S1);
  near(m.monthlyPITIA, 2572.6177);
  near(m.frontEndDti, 28.5846, 0.0005);
  near(m.backEndDti, 35.2513, 0.0005);
  near(m.ltv, 80, 1e-9);
  const conv = evaluateProgram('conventional', S1);
  assert.equal(byId(conv, 'front_dti').status, 'does_not_meet');
  assert.equal(byId(conv, 'back_dti').status, 'meets');
  assert.equal(byId(conv, 'credit').status, 'meets');
  assert.equal(conv.overall, 'does_not_meet');
  assert.equal(evaluateProgram('fha', S1).overall, 'meets');
});

test('scenario 2: income 9000 to 9500 flips conventional front-end to 27.08 and the diff reports it', () => {
  const before = screen(S1, { programs: ['conventional', 'fha'] });
  const after = screen({ ...S1, grossMonthlyIncome: 9500 }, { programs: ['conventional', 'fha'] });
  near(after.metrics.frontEndDti, 27.0802, 0.0005);
  near(after.metrics.backEndDti, 33.396, 0.0005);
  const d = diffScreens(before, after);
  assert.deepEqual(Object.keys(d.metricDeltas).sort(), ['backEndDti', 'frontEndDti']);
  assert.equal(d.newlyFailed.length, 0);
  const passed = d.newlyPassed.find((r) => r.scope === 'program:conventional' && r.id === 'front_dti');
  assert.ok(passed, 'conventional front_dti newly passed');
  assert.equal(passed.from, 'does_not_meet');
  assert.deepEqual(d.overallChanges, [{ scope: 'program:conventional', from: 'does_not_meet', to: 'meets' }]);
});

test('scenario 3: FHA at exactly 96.5 LTV meets (boundary), front-end 36.12 fails, back-end 42.27 meets', () => {
  const fha = {
    purchasePrice: 300000, loanAmount: 289500, rateAnnualPct: 6.75, monthlyTaxes: 300, monthlyInsurance: 120, monthlyHOA: 50,
    grossMonthlyIncome: 6500, monthlyDebts: 400, creditScore: 600,
  };
  const m = computeMetrics(fha);
  near(m.monthlyPI, 1877.6915);
  near(m.frontEndDti, 36.1183, 0.0005);
  near(m.backEndDti, 42.2722, 0.0005);
  const r = evaluateProgram('fha', fha);
  assert.equal(byId(r, 'ltv').status, 'meets');
  assert.equal(byId(r, 'front_dti').status, 'does_not_meet');
  assert.equal(byId(r, 'back_dti').status, 'meets');
  assert.equal(byId(r, 'credit').status, 'meets');
});

test('FHA credit tiers: 575 credit needs 10% down; 480 fails credit outright', () => {
  const base = { purchasePrice: 300000, rateAnnualPct: 6.75, monthlyTaxes: 250, monthlyInsurance: 110, grossMonthlyIncome: 6000, monthlyDebts: 300 };
  const ok = evaluateProgram('fha', { ...base, loanAmount: 270000, creditScore: 575 });
  assert.equal(byId(ok, 'ltv').threshold, 90);
  assert.equal(byId(ok, 'ltv').status, 'meets');
  const bad = evaluateProgram('fha', { ...base, loanAmount: 289500, creditScore: 575 });
  assert.equal(byId(bad, 'ltv').status, 'does_not_meet');
  assert.equal(byId(evaluateProgram('fha', { ...base, loanAmount: 270000, creditScore: 480 }), 'credit').status, 'does_not_meet');
});

test('scenario 4: DSCR 1.07 meets the 1.0 program floor but not Coastal at 1.15; Flex and Summit meet', () => {
  const m = computeMetrics(S4);
  near(m.monthlyPITIA, 3272.0544);
  near(m.dscr, 1.0697, 0.0005);
  assert.equal(evaluateProgram('dscr', S4).overall, 'meets');
  const coastal = evaluateLender({
    lender_name: 'Coastal Capital Partners', lender_type: 'dscr', min_loan_amount: '150000', max_loan_amount: '3000000', min_fico: 680,
    max_ltv: '80', min_dscr: '1.15', allowed_states: ['FL', 'GA', 'TX', 'NC', 'SC'], excluded_states: null, allowed_asset_types: ['sfr', '2_4_unit', 'multifamily'],
  }, S4);
  assert.equal(coastal.overall, 'does_not_meet');
  assert.deepEqual(coastal.checks.filter((c) => c.status === 'does_not_meet').map((c) => c.id), ['dscr']);
  const flex = evaluateLender({
    lender_name: 'FlexLend Mortgage', min_loan_amount: '200000', max_loan_amount: '5000000', min_fico: 640, max_ltv: '85', min_dscr: '1.0',
    allowed_states: ['FL', 'TX'], allowed_asset_types: ['sfr', 'commercial'],
  }, S4);
  assert.equal(flex.overall, 'meets');
  // Summit: max LTV 75 and the deal is exactly 75 (boundary); min_dscr 0 means no DSCR rule
  const summit = evaluateLender({
    lender_name: 'Summit Bridge Fund', min_loan_amount: '100000', max_loan_amount: '2500000', min_fico: 620, max_ltv: '75', min_dscr: '0',
    allowed_states: ['FL', 'GA'], allowed_asset_types: ['sfr', '2_4_unit'],
  }, S4);
  assert.equal(summit.overall, 'meets');
  assert.equal(byId(summit, 'dscr'), undefined);
});

test('lender max_ltv stored as a fraction is normalized and flagged', () => {
  assert.deepEqual(normalizeLtv('0.80'), { value: 80, normalized: true });
  assert.deepEqual(normalizeLtv('80'), { value: 80, normalized: false });
  assert.deepEqual(normalizeLtv(null), { value: null, normalized: false });
  const r = evaluateLender({ lender_name: 'Underlytix', min_loan_amount: '50000', max_loan_amount: '10000000', min_fico: 600, max_ltv: '0.80', min_dscr: null }, S1);
  assert.equal(byId(r, 'ltv').threshold, 80);
  assert.match(byId(r, 'ltv').note, /fraction/);
  assert.equal(r.overall, 'meets');
});

test('lender state and asset rules: excluded state and unknown inputs', () => {
  const p = { lender_name: 'X', allowed_states: null, excluded_states: ['NY'], allowed_asset_types: ['sfr'] };
  assert.equal(byId(evaluateLender(p, { ...S1, state: 'NY' }), 'state').status, 'does_not_meet');
  assert.equal(byId(evaluateLender(p, { ...S1, state: 'FL', assetType: 'condo' }), 'asset_type').status, 'does_not_meet');
  const unknown = evaluateLender(p, { ...S1, state: undefined, assetType: undefined });
  assert.equal(byId(unknown, 'state').status, 'needs_input');
  assert.equal(unknown.overall, 'incomplete');
});

test('scenario 5: conforming limit, high-cost limit, and jumbo are consistent at 900000', () => {
  const big = { purchasePrice: 1125000, loanAmount: 900000, rateAnnualPct: 6.5, monthlyTaxes: 900, monthlyInsurance: 300, grossMonthlyIncome: 20000, monthlyDebts: 500, creditScore: 760, reservesMonths: 8 };
  const m = computeMetrics(big);
  near(m.monthlyPITIA, 6888.6122);
  near(m.frontEndDti, 34.4431, 0.0005);
  near(m.backEndDti, 36.9431, 0.0005);
  assert.equal(byId(evaluateProgram('conventional', big), 'loan_limit').status, 'does_not_meet');
  assert.equal(byId(evaluateProgram('conventional', { ...big, highCostArea: true }), 'loan_limit').status, 'meets');
  assert.equal(byId(evaluateProgram('jumbo', big), 'above_limit').status, 'meets');
  assert.equal(byId(evaluateProgram('jumbo', { ...big, highCostArea: true }), 'above_limit').status, 'does_not_meet');
  assert.equal(CONFORMING_LIMIT, 806500);
  assert.equal(CONFORMING_LIMIT_HIGH_COST, 1209750);
});

test('FHA loan limit: above 524,225 needs the county limit, above 1,209,750 fails', () => {
  const base = { purchasePrice: 700000, rateAnnualPct: 6.5, monthlyTaxes: 500, monthlyInsurance: 200, grossMonthlyIncome: 15000, monthlyDebts: 0, creditScore: 700 };
  assert.equal(byId(evaluateProgram('fha', { ...base, loanAmount: 500000 }), 'loan_limit').status, 'meets');
  assert.equal(byId(evaluateProgram('fha', { ...base, loanAmount: 600000 }), 'loan_limit').status, 'needs_input');
  assert.equal(byId(evaluateProgram('fha', { ...base, loanAmount: 1300000 }), 'loan_limit').status, 'does_not_meet');
});

test('scenario 6: conventional back-end DTI stretches to 50 only with all compensating factors', () => {
  const t = { ...S1, grossMonthlyIncome: 7000, monthlyDebts: 700, creditScore: 740, reservesMonths: 6 };
  const m = computeMetrics(t);
  near(m.backEndDti, 46.7517, 0.0005);
  const withComp = byId(evaluateProgram('conventional', t), 'back_dti');
  assert.equal(withComp.threshold, 50);
  assert.equal(withComp.status, 'meets');
  const noReserves = byId(evaluateProgram('conventional', { ...t, reservesMonths: 3 }), 'back_dti');
  assert.equal(noReserves.threshold, 45);
  assert.equal(noReserves.status, 'does_not_meet');
});

test('scenario 7: a rate move from 6.5 to 8.0 is reported as newly failed FHA front-end and a changed payment', () => {
  const before = screen(S1, { programs: ['conventional', 'fha'] });
  const after = screen({ ...S1, rateAnnualPct: 8.0 }, { programs: ['conventional', 'fha'] });
  near(after.metrics.monthlyPI, 2348.0466);
  near(after.metrics.frontEndDti, 32.2005, 0.0005);
  near(after.metrics.backEndDti, 38.8672, 0.0005);
  const d = diffScreens(before, after);
  assert.equal(d.metricDeltas.monthlyPI.from, 2022.6177);
  assert.equal(d.metricDeltas.monthlyPI.to, 2348.0466);
  assert.ok(!('ltv' in d.metricDeltas));
  assert.deepEqual(d.newlyFailed.map((r) => `${r.scope}/${r.id}`), ['program:fha/front_dti']);
  assert.deepEqual(d.newlyPassed, []);
  assert.deepEqual(d.overallChanges, [{ scope: 'program:fha', from: 'meets', to: 'does_not_meet' }]);
});

test('diff reports lenders added and removed, and a credit drop as newly failed', () => {
  const lender = { lender_name: 'L1', min_fico: 700 };
  const a = screen(S1, { programs: ['conventional'], lenders: [lender] });
  const b = screen({ ...S1, creditScore: 610 }, { programs: ['conventional'] });
  const d = diffScreens(a, b);
  assert.deepEqual(d.removed, ['lender:L1']);
  assert.ok(d.newlyFailed.some((r) => r.scope === 'program:conventional' && r.id === 'credit'));
  const c = diffScreens(b, a);
  assert.deepEqual(c.added, ['lender:L1']);
});

test('every check carries rule, threshold, actual, status and source; version is exported', () => {
  const s = screen(S1);
  assert.equal(s.guidelinesVersion, GUIDELINES_VERSION);
  for (const prog of Object.values(s.programs)) {
    for (const c of prog.checks) {
      for (const k of ['id', 'label', 'rule', 'threshold', 'status', 'source']) assert.ok(k in c, `${prog.program}/${c.id} missing ${k}`);
      assert.ok(['meets', 'does_not_meet', 'needs_input'].includes(c.status));
    }
  }
  assert.throws(() => evaluateProgram('nope', S1), /Unknown program/);
});
