// Pure form-value -> schema mappers and score estimators for the deal-capture
// write path in capiq-analyze.js. No I/O. Ported from the (now-superseded)
// capiq-save-deal edge function, unit-tested in deal-mappers.test.mjs.
//
// The enum outputs here must satisfy these Postgres CHECK constraints:
//   deal_submissions.deal_type  in (fix_flip, rental, cash_out, bridge, construction, commercial)
//   deal_submissions.asset_type in (sfr, 2_4_unit, multifamily, commercial, mixed_use, land)
//   borrowers.experience_level  in (first_time, emerging, experienced, veteran)
//   deal_scores.score_band      in (strong, conditional, hold)
//   deal_scores.*_score         numeric 0..100

export function clamp(n, lo, hi) {
  n = Number(n);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

const isCommercial = (market) => String(market || '').toLowerCase() === 'commercial';

// app.html has two pill sets. Residential (#deal-type-pills): Purchase, Fix & Flip,
// Rental, Cash-Out, Bridge, New Construction. Commercial (#deal-type-pills-comm):
// Acquisition, Refinance, Bridge, Construction, Cash-Out. `market` disambiguates
// the values shared between the two.
export function mapDealType(t, market) {
  if (isCommercial(market)) {
    const cm = { 'Construction': 'construction', 'Bridge': 'bridge', 'Cash-Out': 'cash_out' };
    return cm[t] || 'commercial'; // Acquisition / Refinance / unknown -> commercial
  }
  const m = {
    'Purchase': 'fix_flip', 'Fix & Flip': 'fix_flip', 'Rental': 'rental',
    'Cash-Out': 'cash_out', 'Bridge': 'bridge', 'New Construction': 'construction',
  };
  return m[t] || 'fix_flip';
}

// Residential (#prop-type-pills): SFR, Condo, 2-4 Unit, Multifamily 5+.
// Commercial (#prop-type-pills-comm): Multifamily 5+, Office, Retail, Industrial,
// Mixed Use, Self Storage.
export function mapAssetType(t, market) {
  if (isCommercial(market)) {
    const cm = { 'Multifamily 5+': 'multifamily', 'Mixed Use': 'mixed_use' };
    return cm[t] || 'commercial'; // Office / Retail / Industrial / Self Storage / unknown -> commercial
  }
  const m = {
    'SFR': 'sfr', 'Condo': 'sfr', '2-4 Unit': '2_4_unit',
    'Multifamily 5+': 'multifamily', 'Commercial': 'commercial', 'Land': 'land',
  };
  return m[t] || 'sfr';
}

export function mapExperience(e) {
  if (!e) return 'first_time';
  if (e.includes('First')) return 'first_time';
  if (e.includes('1-3')) return 'emerging';
  if (e.includes('4-10')) return 'experienced';
  return 'veteran';
}

export function mapExperienceCount(e) {
  if (!e) return 0;
  if (e.includes('First')) return 0;
  if (e.includes('1-3')) return 2;
  if (e.includes('4-10')) return 7;
  if (e.includes('10-20')) return 15;
  return 25;
}

export function mapExitStrategy(t, market) {
  if (isCommercial(market)) {
    const cm = {
      'Acquisition': 'hold', 'Refinance': 'refinance', 'Construction': 'sell',
      'Bridge': 'refinance', 'Cash-Out': 'refinance',
    };
    return cm[t] || 'hold';
  }
  const m = {
    'Fix & Flip': 'flip', 'Rental': 'hold', 'Cash-Out': 'refinance',
    'Bridge': 'refinance', 'New Construction': 'sell', 'Purchase': 'hold',
  };
  return m[t] || 'hold';
}

const QM_DEAL_TYPES = ['conventional', 'fha', 'va', 'usda', 'jumbo'];
export function deriveDealCategory(rawDealType) {
  return QM_DEAL_TYPES.includes(String(rawDealType || '').toLowerCase()) ? 'qm' : 'non_qm';
}

export function scoreBand(score) {
  return score >= 65 ? 'strong' : score >= 45 ? 'conditional' : 'hold';
}

export function estimateCollateral(d) {
  const ltv = parseFloat(d.ltv) || 0;
  if (ltv <= 65) return 90;
  if (ltv <= 75) return 75;
  if (ltv <= 80) return 60;
  if (ltv <= 90) return 40;
  return 20;
}

export function estimateCashFlow(d) {
  const dscr = parseFloat(d.dscr) || 0;
  if (!dscr) return 50;
  if (dscr >= 1.5) return 90;
  if (dscr >= 1.25) return 75;
  if (dscr >= 1.0) return 55;
  return 30;
}

export function estimateBorrower(d) {
  const credit = parseFloat(d.creditScore) || 0;
  let score = 0;
  if (credit >= 760) score += 50;
  else if (credit >= 720) score += 40;
  else if (credit >= 680) score += 30;
  else if (credit >= 640) score += 15;
  const exp = d.investorExperience || '';
  if (exp.includes('20+')) score += 50;
  else if (exp.includes('10-20')) score += 40;
  else if (exp.includes('4-10')) score += 30;
  else if (exp.includes('1-3')) score += 15;
  return clamp(score, 0, 100);
}

export function estimateExecution(d) {
  let score = 70;
  if (!d.arv) score -= 10;
  if (!d.rehabBudget && (d.dealType === 'Fix & Flip' || d.dealType === 'New Construction')) score -= 20;
  if (parseFloat(d.ltv) > 90) score -= 20;
  return clamp(score, 0, 100);
}

export function buildRiskFlags(d, a) {
  const flags = [];
  const ltv = parseFloat(d.ltv) || 0;
  const dscr = parseFloat(d.dscr) || 0;
  const credit = parseFloat(d.creditScore) || 0;
  if (ltv > 80) flags.push({ flag: 'high_ltv', severity: 'medium', value: ltv });
  if (dscr > 0 && dscr < 1.0) flags.push({ flag: 'dscr_below_threshold', severity: 'high', value: dscr });
  if (credit > 0 && credit < 660) flags.push({ flag: 'low_credit', severity: 'high', value: credit });
  if (a && a.humanReviewRequired) flags.push({ flag: 'human_review_required', severity: 'low' });
  return flags;
}
