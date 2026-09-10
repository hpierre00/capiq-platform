// Diagnostic: reproduces capiq-lender-portal-v4's PRE-2026-09 token hash (a
// 32-bit non-cryptographic rolling hash) and mints a token for an arbitrary
// lender_profile_id. After the auth fix deploys, POSTing this token to the
// function's `verify` action MUST return {valid:false}. Usage:
//   node scripts/forge-old-lender-token.mjs <lender_profile_id>
const JWT_SECRET = 'capiq-lender-jwt-2026'; // old hardcoded constant

function oldHm(d) {
  const c = d + '|' + JWT_SECRET;
  let h = 0;
  for (let i = 0; i < c.length; i++) { h = ((h << 5) - h) + c.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36) + c.length.toString(36);
}

const lid = process.argv[2] || '00000000-0000-0000-0000-000000000000';
const payload = {
  id: 'forged', email: 'attacker@example.com', lender_profile_id: lid,
  role: 'lender', qm_category: 'both', exp: Date.now() + 7 * 864e5,
};
const d = Buffer.from(JSON.stringify(payload)).toString('base64');
console.log(d + '.' + oldHm(d));
