// Deterministic Capital Readiness Screen rules.
//
// Pure functions, no network, no model calls. Every check carries the rule, the threshold
// and the actual value so a screen can show exactly what it was checked against.
//
// Two rule sources:
//   1. PROGRAM_RULES: the program thresholds Underlytix already told the realtor chat to use
//      (the GUIDELINES block in realtor-prequal.js, labelled 2025/2026). Nothing here is
//      sourced from an agency selling guide or a named vendor; the source label says so.
//   2. Lender profiles: rows from the lender_profiles table, evaluated field by field.
//
// Statuses: 'meets', 'does_not_meet', 'needs_input'. A missing input is never guessed.
// In particular there is no default interest rate: callers must supply one.

export const GUIDELINES_VERSION = '2025-2026';
export const GUIDELINES_SOURCE = 'Underlytix program guideline reference 2025/2026';

export const CONFORMING_LIMIT = 806500;
export const CONFORMING_LIMIT_HIGH_COST = 1209750;
export const FHA_LIMIT_STANDARD = 524225;

const EPS = 1e-9;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (v === null || v === undefined || v === '' ? null : (isNum(Number(v)) ? Number(v) : null));
const round = (v, d = 2) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export function monthlyPayment(principal, annualRatePct, years = 30) {
  if (!isNum(principal) || !isNum(annualRatePct) || !isNum(years) || principal <= 0 || years <= 0) return null;
  const n = years * 12;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / n;
  const g = (1 + r) ** n;
  return (principal * r * g) / (g - 1);
}

// input: purchasePrice, loanAmount | downPayment, rateAnnualPct, termYears (default 30),
// monthlyTaxes, monthlyInsurance, monthlyHOA, grossMonthlyIncome, monthlyDebts, monthlyRent
export function computeMetrics(input) {
  const price = num(input.purchasePrice);
  let loan = num(input.loanAmount);
  if (loan === null && price !== null && num(input.downPayment) !== null) loan = price - num(input.downPayment);
  const rate = num(input.rateAnnualPct);
  const taxes = num(input.monthlyTaxes);
  const ins = num(input.monthlyInsurance);
  const hoa = num(input.monthlyHOA) ?? 0;
  const pi = loan !== null && rate !== null ? monthlyPayment(loan, rate, num(input.termYears) ?? 30) : null;
  const pitia = pi !== null && taxes !== null && ins !== null ? pi + taxes + ins + hoa : null;
  const income = num(input.grossMonthlyIncome);
  const debts = num(input.monthlyDebts) ?? 0;
  const rent = num(input.monthlyRent);
  return {
    loanAmount: loan,
    ltv: loan !== null && price ? (loan / price) * 100 : null,
    monthlyPI: pi,
    monthlyPITIA: pitia,
    frontEndDti: pitia !== null && income ? (pitia / income) * 100 : null,
    backEndDti: pitia !== null && income ? ((pitia + debts) / income) * 100 : null,
    dscr: pitia !== null && rent !== null ? rent / pitia : null,
  };
}

function check(id, label, op, threshold, actual, unit, source, note) {
  let status = 'needs_input';
  if (isNum(actual)) {
    const ok = op === 'lte' ? actual <= threshold + EPS : actual >= threshold - EPS;
    status = ok ? 'meets' : 'does_not_meet';
  }
  const out = { id, label, rule: `${op === 'lte' ? 'at most' : 'at least'} ${threshold}${unit}`, op, threshold, actual: isNum(actual) ? actual : null, unit, status, source };
  if (note) out.note = note;
  return out;
}

function overall(checks) {
  if (checks.some((c) => c.status === 'does_not_meet')) return 'does_not_meet';
  if (checks.some((c) => c.status === 'needs_input')) return 'incomplete';
  return 'meets';
}

const S = GUIDELINES_SOURCE;

export const PROGRAM_RULES = {
  conventional(m, i) {
    const high = i.highCostArea === true;
    const limit = high ? CONFORMING_LIMIT_HIGH_COST : CONFORMING_LIMIT;
    // Back-end DTI may stretch to 50 with strong compensating factors: 20%+ down, 740+ credit, 6+ months reserves.
    const comp = m.ltv !== null && num(i.creditScore) !== null && num(i.reservesMonths) !== null
      && m.ltv <= 80 && num(i.creditScore) >= 740 && num(i.reservesMonths) >= 6;
    return [
      check('credit', 'Credit score', 'gte', 620, num(i.creditScore), '', S),
      check('ltv', 'Loan to value', 'lte', 97, m.ltv, '%', S, 'Assumes 3% minimum down'),
      check('front_dti', 'Front-end DTI', 'lte', 28, m.frontEndDti, '%', S),
      check('back_dti', 'Back-end DTI', 'lte', comp ? 50 : 45, m.backEndDti, '%', S, comp ? 'Extended to 50 with compensating factors (20%+ down, 740+ credit, 6+ months reserves)' : 'Up to 50 only with 20%+ down, 740+ credit and 6+ months reserves'),
      check('reserves', 'Reserves (months of PITIA)', 'gte', 2, num(i.reservesMonths), ' months', S, 'Guideline range is 2 to 6 months'),
      check('loan_limit', high ? 'Loan within high-cost conforming limit' : 'Loan within conforming limit', 'lte', limit, m.loanAmount, '', S),
    ];
  },
  fha(m, i) {
    const credit = num(i.creditScore);
    const ltvMax = credit !== null && credit >= 580 ? 96.5 : 90;
    const checks = [
      check('credit', 'Credit score', 'gte', 500, credit, '', S),
      check('ltv', 'Loan to value', 'lte', ltvMax, m.ltv, '%', S, credit !== null && credit < 580 ? 'Credit 500 to 579 requires 10% down' : '580+ credit allows 3.5% down'),
      check('front_dti', 'Front-end DTI', 'lte', 31, m.frontEndDti, '%', S),
      check('back_dti', 'Back-end DTI', 'lte', 43, m.backEndDti, '%', S, 'Higher ratios need AUS approval, which this screen does not model'),
    ];
    const loan = m.loanAmount;
    let lim = check('loan_limit', 'Loan within FHA limit', 'lte', FHA_LIMIT_STANDARD, loan, '', S);
    if (isNum(loan) && loan > FHA_LIMIT_STANDARD) {
      lim.status = loan > CONFORMING_LIMIT_HIGH_COST ? 'does_not_meet' : 'needs_input';
      lim.note = loan > CONFORMING_LIMIT_HIGH_COST ? 'Above the highest FHA limit' : 'FHA limits vary by county; confirm the county limit';
    }
    checks.push(lim);
    return checks;
  },
  va(m) {
    return [check('back_dti', 'Back-end DTI', 'lte', 41, m.backEndDti, '%', S, 'Guideline; residual income can allow higher')];
  },
  jumbo(m, i) {
    const high = i.highCostArea === true;
    const limit = high ? CONFORMING_LIMIT_HIGH_COST : CONFORMING_LIMIT;
    return [
      check('above_limit', 'Loan above conforming limit', 'gte', limit, m.loanAmount, '', S),
      check('credit', 'Credit score', 'gte', 700, num(i.creditScore), '', S, 'Most lenders want 740+'),
      check('ltv', 'Loan to value', 'lte', 90, m.ltv, '%', S, 'Assumes 10% minimum down'),
      check('back_dti', 'Back-end DTI', 'lte', 43, m.backEndDti, '%', S),
      check('reserves', 'Reserves (months of PITIA)', 'gte', 6, num(i.reservesMonths), ' months', S, 'Guideline range is 6 to 12 months'),
    ];
  },
  dscr(m, i) {
    return [
      check('credit', 'Credit score', 'gte', 660, num(i.creditScore), '', S),
      check('dscr', 'DSCR (rent / PITIA)', 'gte', 1.0, m.dscr, '', S, 'Most lenders want 1.1 to 1.25'),
      check('ltv', 'Loan to value', 'lte', 80, m.ltv, '%', S),
      check('reserves', 'Reserves (months of PITIA)', 'gte', 3, num(i.reservesMonths), ' months', S, 'Guideline range is 3 to 6 months per property'),
    ];
  },
};

export function evaluateProgram(program, input, metrics = computeMetrics(input)) {
  const rules = PROGRAM_RULES[program];
  if (!rules) throw new Error(`Unknown program: ${program}`);
  const checks = rules(metrics, input);
  return { program, overall: overall(checks), checks };
}

// lender_profiles stores max_ltv as a percent for most rows but as a fraction for at least one
// ("0.80"). Values at or below 1 are read as fractions and flagged so the screen can say so.
export function normalizeLtv(v) {
  const n = num(v);
  if (n === null) return { value: null, normalized: false };
  return n > 0 && n <= 1 ? { value: n * 100, normalized: true } : { value: n, normalized: false };
}

export function evaluateLender(profile, input, metrics = computeMetrics(input)) {
  const src = `lender_profiles: ${profile.lender_name}`;
  const checks = [];
  const minLoan = num(profile.min_loan_amount);
  const maxLoan = num(profile.max_loan_amount);
  if (minLoan !== null) checks.push(check('min_loan', 'Minimum loan amount', 'gte', minLoan, metrics.loanAmount, '', src));
  if (maxLoan !== null) checks.push(check('max_loan', 'Maximum loan amount', 'lte', maxLoan, metrics.loanAmount, '', src));
  const minFico = num(profile.min_fico);
  if (minFico !== null) checks.push(check('credit', 'Credit score', 'gte', minFico, num(input.creditScore), '', src));
  const ltv = normalizeLtv(profile.max_ltv);
  if (ltv.value !== null && ltv.value > 0) {
    checks.push(check('ltv', 'Loan to value', 'lte', ltv.value, metrics.ltv, '%', src, ltv.normalized ? 'Stored as a fraction in lender_profiles; read as a percent' : undefined));
  }
  const minDscr = num(profile.min_dscr);
  if (minDscr !== null && minDscr > 0) checks.push(check('dscr', 'DSCR (rent / PITIA)', 'gte', minDscr, metrics.dscr, '', src));
  const state = input.state ? String(input.state).toUpperCase() : null;
  const allowed = Array.isArray(profile.allowed_states) ? profile.allowed_states : null;
  const excluded = Array.isArray(profile.excluded_states) ? profile.excluded_states : null;
  if (allowed || excluded) {
    let status = 'needs_input';
    if (state) status = (allowed && !allowed.includes(state)) || (excluded && excluded.includes(state)) ? 'does_not_meet' : 'meets';
    checks.push({ id: 'state', label: 'State', rule: allowed ? `one of ${allowed.join(', ')}` : `not in ${excluded.join(', ')}`, op: 'in', threshold: allowed || excluded, actual: state, unit: '', status, source: src });
  }
  const assets = Array.isArray(profile.allowed_asset_types) ? profile.allowed_asset_types : null;
  if (assets) {
    const a = input.assetType || null;
    checks.push({ id: 'asset_type', label: 'Asset type', rule: `one of ${assets.join(', ')}`, op: 'in', threshold: assets, actual: a, unit: '', status: a ? (assets.includes(a) ? 'meets' : 'does_not_meet') : 'needs_input', source: src });
  }
  return { lender: profile.lender_name, lenderType: profile.lender_type || null, overall: overall(checks), checks };
}

export function screen(input, { programs = Object.keys(PROGRAM_RULES), lenders = [] } = {}) {
  const metrics = computeMetrics(input);
  return {
    guidelinesVersion: GUIDELINES_VERSION,
    metrics,
    programs: Object.fromEntries(programs.map((p) => [p, evaluateProgram(p, input, metrics)])),
    lenders: lenders.map((l) => evaluateLender(l, input, metrics)),
  };
}

const METRIC_KEYS = ['loanAmount', 'ltv', 'monthlyPI', 'monthlyPITIA', 'frontEndDti', 'backEndDti', 'dscr'];

// Compares two screens (before and after the realtor changes an input). Only rules present in both
// screens are compared; a rule that appears or disappears is reported under added/removed.
export function diffScreens(before, after) {
  const metricDeltas = {};
  for (const k of METRIC_KEYS) {
    const a = before.metrics[k]; const b = after.metrics[k];
    const changed = (a === null) !== (b === null) || (a !== null && b !== null && Math.abs(a - b) > 1e-6);
    if (changed) metricDeltas[k] = { from: round(a, 4), to: round(b, 4) };
  }
  const flat = (s) => {
    const m = new Map();
    for (const [p, r] of Object.entries(s.programs)) { m.set(`program:${p}`, { overall: r.overall, checks: r.checks }); }
    for (const l of s.lenders) { m.set(`lender:${l.lender}`, { overall: l.overall, checks: l.checks }); }
    return m;
  };
  const A = flat(before); const B = flat(after);
  const newlyFailed = []; const newlyPassed = []; const overallChanges = []; const added = []; const removed = [];
  for (const [scope, b] of B) {
    const a = A.get(scope);
    if (!a) { added.push(scope); continue; }
    if (a.overall !== b.overall) overallChanges.push({ scope, from: a.overall, to: b.overall });
    const prev = new Map(a.checks.map((c) => [c.id, c]));
    for (const c of b.checks) {
      const p = prev.get(c.id);
      if (!p || p.status === c.status) continue;
      const row = { scope, id: c.id, label: c.label, from: p.status, to: c.status, threshold: c.threshold, actualFrom: round(p.actual, 4), actualTo: round(c.actual, 4) };
      if (c.status === 'does_not_meet') newlyFailed.push(row);
      else if (c.status === 'meets') newlyPassed.push(row);
    }
  }
  for (const scope of A.keys()) if (!B.has(scope)) removed.push(scope);
  return { metricDeltas, overallChanges, newlyFailed, newlyPassed, added, removed };
}
