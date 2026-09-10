# Underlytix Deal-Capture Consolidation + Lender-Portal Auth Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the investor "Analyze Deal" flow persist a complete, correct row set to Supabase (one path, not two half-built ones), and close the forgeable-token + static-salt vulnerability in the lender portal first.

**Architecture:** Two phases. **Phase 1** hardens `capiq-lender-portal-v4` (Supabase edge function) by porting `capiq-realtor-auth-v5`'s HMAC-SHA256 token signing and PBKDF2 password hashing — no full Supabase Auth migration. **Phase 2** consolidates deal capture onto Path A (`netlify/functions/capiq-analyze.js`'s deferred `waitUntil` block): extract pure mapping/scoring helpers into a unit-tested module, extend the deferred write block to cover `borrowers` + `deal_scores` + `platform_events` with all CHECK-constrained columns mapped, add inline investor-token resolution, add write-failure observability, and remove the second path's caller from `app.html`. A one-line migration adds the `borrowers.email` unique constraint the write path needs.

**Tech Stack:** Deno + WebCrypto (edge function), Node 24 ESM + `node:test` (Netlify function + helper tests), PostgREST (raw `fetch` from the Netlify function), Supabase MCP (`apply_migration`, `deploy_edge_function`, `execute_sql`), git → `push_site.bat` → Netlify auto-deploy for `.js`/`.html`.

**Spec:** `docs/superpowers/specs/2026-09-10-underlytix-deal-capture-consolidation-design.md` — read it alongside this plan; every task argues from it.

## Global Constraints

- **Supabase project id:** `mxyepucitjzleaziizkr` (URL `https://mxyepucitjzleaziizkr.supabase.co`).
- **Netlify site id:** `f7733dc6-b916-4bed-9ffc-da3a467142ad`.
- **Branch:** `feat/deal-capture-consolidation` (already pushed; base for all commits).
- **Deploy order is a security requirement:** Phase 1 (lender auth) deploys **before or with** Phase 2 — never after. See spec §1.3 / §5.
- **Netlify env var name is `SUPABASE_SERVICE_KEY`** (not `SUPABASE_SERVICE_ROLE_KEY`; the latter is auto-injected into edge functions only).
- **Edge-function token payload shape must not change:** `{ id, email, lender_profile_id, role, qm_category, exp }`.
- **jsonb columns get native objects/arrays**, never `JSON.stringify(...)` strings.
- **CHECK constraint values (copy verbatim):**
  - `deal_submissions.deal_type` ∈ `fix_flip | rental | cash_out | bridge | construction | commercial`
  - `deal_submissions.asset_type` ∈ `sfr | 2_4_unit | multifamily | commercial | mixed_use | land`
  - `deal_submissions.deal_code` — `NOT NULL`, has default, `UNIQUE`; **do not supply it on insert**
  - `borrowers.experience_level` ∈ `first_time | emerging | experienced | veteran`
  - `borrowers.borrower_type` ∈ `individual | llc | corporation | trust`
  - `deal_scores.score_band` ∈ `strong | conditional | hold`
  - `deal_scores.*_score` — numeric, CHECK `0 <= x <= 100`
  - `lender_matches.match_status` ∈ `matched | conditional | rejected` (**not** `pending`)
  - `lender_matches.interest_level` ∈ `pending | interested | not_interested | term_sheet_issued | closed`
- **No deno locally.** Edge-function changes are verified by deploy + smoke, plus a Node reproduction of the *old* token algorithm to prove forgery now fails.
- **Do not touch `app.html` calc functions or `lender.html`** — the P0-3 calc-test workstream owns those in parallel.

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `supabase/functions/capiq-lender-portal-v4/index.ts` | Modify (auth primitives) | Lender portal auth + deal read/triage. Rewrite `hm`/`hp` → HMAC-SHA256 + PBKDF2; keep all actions and payload shape. |
| `scripts/forge-old-lender-token.mjs` | Create (diagnostic, kept) | Reproduces the pre-fix 32-bit token hash so the smoke test can confirm forged tokens are rejected. |
| `netlify/functions/lib/deal-mappers.mjs` | Create | Pure functions: form-value → enum mappers, score estimators, risk flags, `clamp`, `scoreBand`, `deriveDealCategory`. No I/O. |
| `netlify/functions/lib/deal-mappers.test.mjs` | Create | `node:test` unit tests for every function in `deal-mappers.mjs`. |
| `netlify/functions/capiq-analyze.js` | Modify (`supabaseTask` ≈ L378–479, imports) | AI analysis endpoint. Extend the deferred Supabase write block; add investor-token resolve; add failure logging. |
| `app.html` | Modify (≈ L2266–2327, ≈ L2409 badge) | Send session token to `capiq-analyze`; remove the `capiq-save-deal` call; badge shows the client-generated deal code (display-only). |
| `package.json` | Modify (`scripts`) | Add `"test": "node --test"` (coordinate with P0-3 workstream — no-op if already added). |
| `supabase/migrations/` (via MCP) | Create migration | `add_borrowers_email_unique`. |

---

## Phase 1 — Lender-portal auth hardening

### Task 1: Port HMAC-SHA256 token signing + PBKDF2 password hashing into `capiq-lender-portal-v4`

**Files:**
- Modify: `supabase/functions/capiq-lender-portal-v4/index.ts`
- Create: `scripts/forge-old-lender-token.mjs`

**Interfaces:**
- Produces (edge fn internal): `async gt(id,email,lid,role,qmc) -> string`, `async vt(token) -> payload|null`, `async newHash(pw) -> string`, `async verifyHash(pw, stored) -> boolean`. All become `async` — every call site must `await`.
- Produces (script): `node scripts/forge-old-lender-token.mjs <lender_profile_id>` prints a token string signed with the **old** algorithm.
- Consumes: `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` (auto-present in edge runtime).

- [ ] **Step 1: Read the reference implementation**

Read `supabase/functions/capiq-realtor-auth-v5/index.ts` in full. The functions to port are `hmacKey()`, `newHash()`, `verifyHash()`, and the `async` token `gt()`/`vt()`/`hm()` pattern. Read the current `supabase/functions/capiq-lender-portal-v4/index.ts` in full — note every call to `vt(`, `gt(`, `hp(`.

- [ ] **Step 2: Write the forged-token reproduction script**

Create `scripts/forge-old-lender-token.mjs`:

```js
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
```

- [ ] **Step 3: Run the script to confirm it produces a token**

Run: `node scripts/forge-old-lender-token.mjs 11111111-1111-1111-1111-111111111111`
Expected: prints a single `base64.shorthash` string, no error.

- [ ] **Step 4: Replace the token + hash primitives in `index.ts`**

In `supabase/functions/capiq-lender-portal-v4/index.ts`:

Replace the constants block:

```ts
const SALT = 'capiq-lender-salt-2026';       // legacy SHA-256 salt — verify-only fallback
const PBKDF2_ITERATIONS = 210000;
```
(delete the old `JWT_SECRET` constant.)

Replace `hm()` and add the key deriver:

```ts
let _hmacKey: CryptoKey | null = null;
async function hmacKey(): Promise<CryptoKey> {
  if (_hmacKey) return _hmacKey;
  const root = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const rk = await crypto.subtle.importKey('raw', new TextEncoder().encode(root), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', rk, new TextEncoder().encode('capiq-lender-legacy-token-v1'));
  _hmacKey = await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return _hmacKey;
}
async function hmSign(d: string): Promise<string> {
  const key = await hmacKey();
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(d));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

Replace `gt()` and `vt()`:

```ts
async function gt(id, email, lid, role, qmc): Promise<string> {
  const p = { id, email, lender_profile_id: lid, role, qm_category: qmc, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const d = btoa(JSON.stringify(p));
  return d + '.' + await hmSign(d);
}
async function vt(t): Promise<any> {
  try {
    if (!t) return null;
    const [d, s] = t.split('.');
    if (!d || !s) return null;
    const expected = await hmSign(d);
    if (expected.length !== s.length) return null;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= expected.charCodeAt(i) ^ s.charCodeAt(i);
    if (diff !== 0) return null;
    const p = JSON.parse(atob(d));
    return p.exp < Date.now() ? null : p;
  } catch (_e) {
    return null;
  }
}
```

Replace `hp()` with `legacyHash()` + add PBKDF2:

```ts
async function legacyHash(pw: string): Promise<string> {
  const d = new TextEncoder().encode(pw + SALT);
  const h = await crypto.subtle.digest('SHA-256', d);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function newHash(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, km, 256);
  return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' + btoa(String.fromCharCode(...salt)) + '$' + btoa(String.fromCharCode(...new Uint8Array(bits)));
}
async function verifyHash(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    if (parts.length !== 4) return false;
    const iter = parseInt(parts[1], 10);
    const salt = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, 256);
    const got = btoa(String.fromCharCode(...new Uint8Array(bits)));
    const exp = parts[3];
    if (got.length !== exp.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ exp.charCodeAt(i);
    return diff === 0;
  }
  return stored === await legacyHash(pw);
}
```

- [ ] **Step 5: Update every call site**

- `login` action: change `const hash = await hp(b.password); if (!u || u.password_hash !== hash) return res({ error: 'Invalid credentials.' }, 401);` to:

```ts
if (!u || !(await verifyHash(b.password, u.password_hash))) return res({ error: 'Invalid credentials.' }, 401);
if (!u.password_hash?.startsWith('pbkdf2$')) {
  await sb.from('lender_users').update({ password_hash: await newHash(b.password) }).eq('id', u.id);
}
```
  Keep the existing `last_login` update and token issue. `token: gt(...)` → `token: await gt(...)`.

- `verify` action: `const p = vt(token);` → `const p = await vt(token);`
- `get_deals` action: `const p = vt(token);` → `const p = await vt(token);`
- `update_match` action: `const p = vt(token);` → `const p = await vt(token);`
- `change_password` action: `const p = vt(token);` → `const p = await vt(token);` and both `await hp(currentPassword)` → `await verifyHash(currentPassword, u.password_hash)` (it's a boolean now — invert the comparison), and `password_hash: await hp(newPassword)` → `password_hash: await newHash(newPassword)`.
- `reset_password` action: `password_hash: await hp(np)` → `password_hash: await newHash(np)`.
- `create_checkout` action: `const p = vt(token);` → `const p = await vt(token);`

Grep the final file for `\bhp(` and bare `vt(` / `gt(` without `await` — there must be none.

- [ ] **Step 6: Static sanity check the file**

Run: `node --input-type=module --check < supabase/functions/capiq-lender-portal-v4/index.ts`
Expected: no output, exit 0. (Node can parse the TS-lite syntax used here; it has no type annotations that break parsing except `: Promise<string>` etc. If Node's `--check` errors on type annotations, skip this step and rely on Step 7's deploy — note it in the commit message.)

If `--check` fails purely on type annotations, instead run this grep gate:
Run: `grep -nE '\b(vt|gt)\(' supabase/functions/capiq-lender-portal-v4/index.ts | grep -v await`
Expected: no output (every `vt(`/`gt(` call is awaited; definitions `async function gt(`/`async function vt(` are fine to appear — verify by eye).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/capiq-lender-portal-v4/index.ts scripts/forge-old-lender-token.mjs
git commit -m "feat(lender-auth): HMAC-SHA256 tokens + PBKDF2 password hashing in capiq-lender-portal-v4

Replaces the forgeable 32-bit rolling-hash token signature and static-salt
SHA-256 password hash with the capiq-realtor-auth-v5 pattern (HMAC key
derived from SUPABASE_SERVICE_ROLE_KEY; PBKDF2 210k with auto-upgrade on
login). Token payload shape unchanged. Old tokens no longer verify -> the
4 existing lender sessions re-login once.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013gtwKXcTRykXJxmRxLRxsR"
```

---

### Task 2: Deploy `capiq-lender-portal-v4` and smoke-verify

**Files:** none (deploy + verification only)

**Interfaces:**
- Consumes: Task 1's committed `index.ts`, `scripts/forge-old-lender-token.mjs`.
- Produces: a deployed edge function version; a known-good test lender credential for Phase 2 smoke.

- [ ] **Step 1: Capture the current deployed version for rollback**

Use Supabase MCP `list_edge_functions` (project `mxyepucitjzleaziizkr`); record `capiq-lender-portal-v4`'s current `version` number. This is the rollback target.

- [ ] **Step 2: Deploy**

Use Supabase MCP `deploy_edge_function`: project `mxyepucitjzleaziizkr`, slug `capiq-lender-portal-v4`, `verify_jwt: false`, files = the full contents of `supabase/functions/capiq-lender-portal-v4/index.ts` (as `index.ts`) plus its existing `deno.json` if the current deployment has one (check `get_edge_function` first and mirror its `files` list).

**This step requires explicit user approval before running.**

- [ ] **Step 3: Seed a known test-lender password (legacy format, to also test auto-upgrade)**

Compute a legacy-format hash locally:
Run: `node -e "const c=require('crypto');process.stdout.write(c.createHash('sha256').update('SmokeTest!2026'+'capiq-lender-salt-2026').digest('hex'))"`
Copy the hex output. Then via Supabase MCP `execute_sql`:

```sql
update lender_users
set password_hash = '<hex-from-above>'
where email = 'portal@coastalcapital.com'
returning email, left(password_hash, 12) as hash_prefix;
```

- [ ] **Step 4: Smoke — login works, legacy hash auto-upgrades**

`POST https://mxyepucitjzleaziizkr.supabase.co/functions/v1/capiq-lender-portal-v4`
body: `{"action":"login","email":"portal@coastalcapital.com","password":"SmokeTest!2026"}`

Expected: `200`, `{ success: true, token: "<base64>.<64-hex-char sig>", user: {...} }`. The signature after the `.` must be 64 hex chars (SHA-256), not the short old format.

Then re-check the hash upgraded:
```sql
select email, left(password_hash, 8) as prefix from lender_users where email = 'portal@coastalcapital.com';
```
Expected: `prefix` = `pbkdf2$1`.

- [ ] **Step 5: Smoke — the returned token verifies**

`POST` same URL, body `{"action":"verify","token":"<token from Step 4>"}`
Expected: `200`, `{ valid: true, user: {...} }`.

- [ ] **Step 6: Smoke — a forged old-format token is REJECTED**

Get a real `lender_profile_id`:
```sql
select lender_profile_id from lender_users where email = 'portal@coastalcapital.com';
```
Run: `node scripts/forge-old-lender-token.mjs <that-id>`
`POST` the function, body `{"action":"verify","token":"<forged token>"}`
Expected: `200`, `{ valid: false }`. **If this returns `valid:true`, STOP — the fix failed, roll back to the Step 1 version.**

- [ ] **Step 7: Smoke — get_deals still works with a real token**

`POST` body `{"action":"get_deals","token":"<token from Step 4>"}`
Expected: `200`, `{ success: true, matches: [...] }` (array may be empty; must not error).

- [ ] **Step 8: Record outcome**

Note in the branch (a comment on the eventual PR, or `docs/superpowers/plans/` scratch): deployed version number, that Steps 4–7 passed. Leave the `portal@coastalcapital.com` password as `SmokeTest!2026` for Phase 2 Task 7, or reset it — either way note the state.

---

## Phase 2 — Deal-capture consolidation

### Task 3: Extract and unit-test the pure mapping/scoring helpers

**Files:**
- Create: `netlify/functions/lib/deal-mappers.mjs`
- Create: `netlify/functions/lib/deal-mappers.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces (all named exports of `deal-mappers.mjs`, consumed by Task 5):
  - `clamp(n: number, lo: number, hi: number) -> number`
  - `mapDealType(formValue: string) -> string` (returns a `deal_submissions.deal_type` enum value; default `'fix_flip'`)
  - `mapAssetType(formValue: string) -> string` (enum value; default `'sfr'`)
  - `mapExperience(formValue: string) -> string` (`borrowers.experience_level` enum; default `'first_time'`)
  - `mapExperienceCount(formValue: string) -> number` (default `0`)
  - `mapExitStrategy(formDealType: string) -> string` (default `'hold'`)
  - `deriveDealCategory(rawFormDealType: string) -> 'qm' | 'non_qm'`
  - `scoreBand(score: number) -> 'strong' | 'conditional' | 'hold'`
  - `estimateCollateral(d) -> number` / `estimateCashFlow(d) -> number` / `estimateBorrower(d) -> number` / `estimateExecution(d) -> number` — each already clamped to 0–100
  - `buildRiskFlags(d, a) -> Array<{flag,severity,value?}>`
  - where `d` is the raw `dealData` object and `a` is the `analysis` object.

- [ ] **Step 1: Write the failing tests**

Create `netlify/functions/lib/deal-mappers.test.mjs`:

```js
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

test('mapDealType maps known form values and stays in enum', () => {
  assert.equal(mapDealType('Fix & Flip'), 'fix_flip');
  assert.equal(mapDealType('New Construction'), 'construction');
  assert.equal(mapDealType('Rental'), 'rental');
  assert.equal(mapDealType('Cash-Out'), 'cash_out');
  assert.equal(mapDealType('Bridge'), 'bridge');
  for (const v of ['', 'conventional', 'anything', undefined]) {
    assert.ok(DEAL_TYPE_ENUM.includes(mapDealType(v)), `${v} -> ${mapDealType(v)}`);
  }
});

test('mapAssetType maps known form values and stays in enum', () => {
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
```

- [ ] **Step 2: Add the test script and run to verify it fails**

In `package.json`, add to `"scripts"`: `"test": "node --test"`. (If the P0-3 workstream already added a `test` script by merge time, keep theirs if it's `node --test`-compatible; this plan assumes `node --test` discovery of `**/*.test.mjs`.)

Run: `npm test`
Expected: FAIL — `Cannot find module '.../deal-mappers.mjs'`.

- [ ] **Step 3: Implement `deal-mappers.mjs`**

Create `netlify/functions/lib/deal-mappers.mjs`. Port the helper bodies from `capiq-save-deal` (fetch its current source via Supabase MCP `get_edge_function` slug `capiq-save-deal` for the exact `mapDealType`/`mapAssetType`/`mapExperience`/`mapExperienceCount`/`mapExitStrategy`/`estimate*`/`buildRiskFlags` bodies), adjusted to named ESM exports and with the additions below:

```js
export function clamp(n, lo, hi) {
  n = Number(n);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function mapDealType(t) {
  const m = {
    'Purchase': 'fix_flip', 'Fix & Flip': 'fix_flip', 'Rental': 'rental',
    'Cash-Out': 'cash_out', 'Bridge': 'bridge', 'New Construction': 'construction',
  };
  return m[t] || 'fix_flip';
}

export function mapAssetType(t) {
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

export function mapExitStrategy(t) {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests green. If `buildRiskFlags` `low_credit` test fails on `credit: '600'`, confirm the `credit > 0` guard is present (a `0` credit from missing input must not flag).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/deal-mappers.mjs netlify/functions/lib/deal-mappers.test.mjs package.json
git commit -m "feat(deal-capture): extract tested form-value -> schema mappers

Pure module for deal_submissions/borrowers/deal_scores enum mapping, score
estimators, risk flags. Ported from capiq-save-deal, now unit-tested with
node:test. Consumed by capiq-analyze.js in the next task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013gtwKXcTRykXJxmRxLRxsR"
```

---

### Task 4: Add the `borrowers.email` unique constraint

**Files:** migration via Supabase MCP `apply_migration` (project `mxyepucitjzleaziizkr`).

**Interfaces:**
- Produces: `borrowers_email_key UNIQUE (email)` — enables `on_conflict=email` upsert in Task 5.

- [ ] **Step 1: Re-verify safety immediately before applying**

Supabase MCP `execute_sql`:
```sql
select email, count(*) from borrowers where email is not null group by email having count(*) > 1;
```
Expected: **0 rows.** If any row returns, STOP and report — the spec's safety assumption is violated and the duplicates must be resolved first.

- [ ] **Step 2: Apply the migration**

Supabase MCP `apply_migration`: name `add_borrowers_email_unique`, query:
```sql
ALTER TABLE borrowers ADD CONSTRAINT borrowers_email_key UNIQUE (email);
```

- [ ] **Step 3: Verify it landed**

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'borrowers'::regclass and contype = 'u';
```
Expected: one row, `borrowers_email_key` → `UNIQUE (email)`.

- [ ] **Step 4: Record**

No git commit (schema change is in Supabase's migration table). Note the migration name + timestamp on the PR.

---

### Task 5: Rewrite `capiq-analyze.js`'s `supabaseTask` — complete, correct, observable

**Files:**
- Modify: `netlify/functions/capiq-analyze.js` — add import at top; replace the `supabaseTask` block (currently ≈ L405–470) and the `!SVC_KEY` branch; touch the `catch` in the same area.

**Interfaces:**
- Consumes: `deal-mappers.mjs` exports (Task 3); `body.token` (Task 6 sends it); `SUPABASE_SERVICE_KEY` env (Task 7 sets it).
- Produces: rows in `borrowers`, `deal_submissions`, `deal_scores`, `lender_matches`, `platform_events`; a `deal_save_failed` `platform_events` row + `console.error` on failure.

- [ ] **Step 1: Add the import**

At the top of `netlify/functions/capiq-analyze.js`, after the existing `const` model declarations (before `export default`):

```js
import {
  clamp, mapDealType, mapAssetType, mapExperience, mapExperienceCount,
  mapExitStrategy, deriveDealCategory, scoreBand,
  estimateCollateral, estimateCashFlow, estimateBorrower, estimateExecution,
  buildRiskFlags,
} from './lib/deal-mappers.mjs';
```

- [ ] **Step 2: Replace the `!SVC_KEY` silent branch**

Find `const supabaseTask = SVC_KEY ? (async () => {` … `})() : Promise.resolve();`

Change the falsy branch from `Promise.resolve()` to:

```js
: (console.error('[capiq-save] SUPABASE_SERVICE_KEY unset — deal persistence disabled'), Promise.resolve());
```

- [ ] **Step 3: Replace the body of the `async () => { … }` IIFE**

Replace everything inside `(async () => { try { … } catch(e) { … } })()` with:

```js
const SB = 'https://mxyepucitjzleaziizkr.supabase.co';
const H = { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, 'Content-Type': 'application/json' };
let stage = 'init';
let dealCodeForLog = null;
try {
  // 1. Resolve investor from the session token (deferred; never on the response path).
  stage = 'investor';
  let investorId = null;
  const tok = body.token || null;
  if (tok && tok.split('.').length === 3) {
    const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SVC_KEY, Authorization: `Bearer ${tok}` } });
    if (ur.ok) {
      const u = await ur.json();
      if (u && u.email) {
        const ir = await fetch(`${SB}/rest/v1/investors?select=id&email=eq.${encodeURIComponent(u.email)}`, { headers: H });
        if (ir.ok) { const rows = await ir.json(); investorId = rows[0]?.id || null; }
      }
    }
  }

  // 2. Upsert borrower.
  stage = 'borrower';
  let borrowerId = null;
  const borrowerRow = {
    borrower_name: d.investorName || 'Unknown',
    email: d.investorEmail || null,
    phone: d.investorPhone || null,
    fico: parseInt(d.creditScore, 10) || null,
    experience_level: mapExperience(d.investorExperience),
    experience_count: mapExperienceCount(d.investorExperience),
    borrower_type: 'individual',
    updated_at: new Date().toISOString(),
  };
  const bHeaders = d.investorEmail
    ? { ...H, Prefer: 'resolution=merge-duplicates,return=representation' }
    : { ...H, Prefer: 'return=representation' };
  const bUrl = d.investorEmail
    ? `${SB}/rest/v1/borrowers?on_conflict=email`
    : `${SB}/rest/v1/borrowers`;
  const bRes = await fetch(bUrl, { method: 'POST', headers: bHeaders, body: JSON.stringify(borrowerRow) });
  if (bRes.ok) { const rows = await bRes.json(); borrowerId = rows[0]?.id || null; }
  else console.error('[capiq-save] borrower upsert failed:', bRes.status, await bRes.text().catch(() => ''));

  // 3. Insert deal_submission. deal_code is intentionally omitted (DB default + UNIQUE).
  stage = 'deal';
  const dealCategory = deriveDealCategory(d.dealType); // raw form value, before mapping
  const dealRow = {
    borrower_id: borrowerId,
    deal_type: mapDealType(d.dealType),
    asset_type: mapAssetType(d.propertyType),
    state: d.state || null,
    city: d.location || null,
    purchase_price: parseFloat(d.purchasePrice) || null,
    current_value: parseFloat(d.asIsValue) || null,
    arv: parseFloat(d.arv) || null,
    requested_loan_amount: parseFloat(d.loanAmount) || null,
    requested_ltv: parseFloat(d.ltv) || null,
    dscr: parseFloat(d.dscr) || null,
    monthly_rent: parseFloat(d.monthlyRent) || null,
    rehab_budget: parseFloat(d.rehabBudget) || null,
    exit_strategy: mapExitStrategy(d.dealType),
    deal_category: dealCategory,
    investor_id: investorId,
    investor_name: d.investorName || null,
    investor_email: d.investorEmail || null,
    ai_analysis: analysis,
  };
  const dRes = await fetch(`${SB}/rest/v1/deal_submissions`, {
    method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(dealRow),
  });
  if (!dRes.ok) { console.error('[capiq-save] deal insert failed:', dRes.status, await dRes.text().catch(() => '')); throw new Error('deal insert failed'); }
  const [savedDeal] = await dRes.json();
  if (!savedDeal?.id) throw new Error('deal insert returned no id');
  dealCodeForLog = savedDeal.deal_code || null;

  // 4. Insert deal_score.
  stage = 'scores';
  const fund = clamp(Number(analysis.fundabilityScore) || 0, 0, 100);
  const scoreRow = {
    deal_id: savedDeal.id,
    total_fundability_score: fund,
    score_band: scoreBand(fund),
    collateral_strength_score: clamp(estimateCollateral(d), 0, 100),
    cash_flow_strength_score: clamp(estimateCashFlow(d), 0, 100),
    borrower_strength_score: clamp(estimateBorrower(d), 0, 100),
    execution_risk_score: clamp(estimateExecution(d), 0, 100),
    lender_fit_score: clamp((routableCount => routableCount * 20)(0), 0, 100), // set after step 5 knows routable count
    rationale_json: [
      { section: 'executive_summary', text: analysis.executiveSummary || '' },
      { section: 'strengths_risks', text: analysis.strengthsAndRisks || '' },
      { section: 'score_breakdown', text: analysis.scoreBreakdown || '' },
      { section: 'structuring', text: analysis.structuringRecommendations || '' },
      { section: 'next_steps', text: analysis.nextSteps || '' },
      { section: 'market_context', text: analysis.marketContext || '' },
    ],
    risk_flags_json: buildRiskFlags(d, analysis),
    scoring_version: 'v2.0',
  };

  // 5. Route + insert lender_matches (existing qm_category logic, fixed match_status).
  stage = 'matches';
  const lRes = await fetch(
    `${SB}/rest/v1/lender_users?select=id,lender_profile_id,qm_category&or=(qm_category.eq.${dealCategory},qm_category.eq.both)&limit=50`,
    { headers: H },
  );
  const lenders = lRes.ok ? await lRes.json() : [];
  const routable = lenders.filter((l) => l.lender_profile_id);
  scoreRow.lender_fit_score = clamp(routable.length * 20, 0, 100);

  const sRes = await fetch(`${SB}/rest/v1/deal_scores`, { method: 'POST', headers: H, body: JSON.stringify(scoreRow) });
  if (!sRes.ok) console.error('[capiq-save] deal_scores insert failed:', sRes.status, await sRes.text().catch(() => ''));

  if (routable.length) {
    const matchRows = routable.map((l) => ({
      deal_id: savedDeal.id,
      lender_id: l.lender_profile_id,
      match_status: fund >= 80 ? 'matched' : 'conditional',
      interest_level: 'pending',
      match_score: fund,
      deal_score_val: fund,
      routed_at: new Date().toISOString(),
    }));
    const mRes = await fetch(`${SB}/rest/v1/lender_matches`, { method: 'POST', headers: H, body: JSON.stringify(matchRows) });
    if (!mRes.ok) console.error('[capiq-save] lender_matches insert failed:', mRes.status, await mRes.text().catch(() => ''));
  }

  // 6. Log success event.
  stage = 'events';
  await fetch(`${SB}/rest/v1/platform_events`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      event_type: 'deal_analyzed',
      user_type: 'investor',
      user_id: investorId,
      metadata: {
        deal_code: savedDeal.deal_code, deal_id: savedDeal.id,
        score: fund, verdict: analysis.dealScore, deal_type: d.dealType,
        state: d.state, lender_matches: routable.length, anonymous: investorId == null,
      },
    }),
  }).catch(() => {});
} catch (e) {
  console.error('[capiq-save] deal persistence failed at stage', stage, ':', e?.message, e?.stack);
  try {
    await fetch(`${SB}/rest/v1/platform_events`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        event_type: 'deal_save_failed', user_type: 'investor',
        metadata: { stage, error: String(e?.message || e), deal_code: dealCodeForLog },
      }),
    });
  } catch (_) { /* Supabase-wide failure — console.error above is the signal */ }
}
```

Note: `scoreRow.lender_fit_score` is initialized with a placeholder then overwritten once `routable.length` is known (step 5), and `deal_scores` is inserted *after* that — so the inline IIFE placeholder `(routableCount => routableCount * 20)(0)` can be simplified to `0`; keep whichever is clearer. The `deal_scores` POST must run after `scoreRow.lender_fit_score` is set.

- [ ] **Step 4: Verify `d`, `analysis`, `body` are in scope**

Confirm the enclosing function still has `const d = ...` (the parsed `dealData`), `analysis`, and `body` (the parsed request body) available where `supabaseTask` is defined. If `body` is not retained (only `d`/`analysis`), add `const body = <the already-parsed request JSON>` — do **not** re-read `req.json()` (the stream is consumed). Search upward for where `dealData` is destructured and reuse that same object.

- [ ] **Step 5: Syntax-check**

Run: `npm run check`
Expected: CHECK 1 passes for `capiq-analyze.js` (no `SyntaxError`). CHECK 2/3 unaffected.

Run: `node --check netlify/functions/lib/deal-mappers.mjs`
Expected: exit 0.

- [ ] **Step 6: Run the helper tests again (import path regression)**

Run: `npm test`
Expected: PASS (unchanged from Task 3).

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/capiq-analyze.js
git commit -m "feat(deal-capture): capiq-analyze.js writes the full row set, observably

supabaseTask now: resolves investor_id from the session token (deferred),
upserts borrowers, inserts deal_submissions (enum-mapped, deal_code left to
DB default), deal_scores (native jsonb, clamped), lender_matches (valid
match_status, was 'pending'), platform_events. Failures -> console.error +
best-effort deal_save_failed event. Missing SUPABASE_SERVICE_KEY now logs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013gtwKXcTRykXJxmRxLRxsR"
```

---

### Task 6: `app.html` — send the token, drop the second save path, fix the badge

**Files:**
- Modify: `app.html` — the analyze handler (≈ L2266–2327) and the badge span (≈ L2409).

**Interfaces:**
- Consumes: `getSession()` (existing), `enrichedDealData.dealCode` (existing, L2270).
- Produces: `capiq-analyze` request body now includes `token`; no `capiq-save-deal` request.

- [ ] **Step 1: Send the token to `capiq-analyze`**

Find (≈ L2290):
```js
const res = await fetch('/.netlify/functions/capiq-analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dealData: enrichedDealData, prompt: analysisPrompt})});
```
Change the body to:
```js
body:JSON.stringify({dealData: enrichedDealData, prompt: analysisPrompt, token: getSession()?.token || null})
```

- [ ] **Step 2: Remove the `capiq-save-deal` call and point the badge at the client code**

Find the block (≈ L2318–2327):
```js
    fetch('https://mxyepucitjzleaziizkr.supabase.co/functions/v1/capiq-save-deal', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ dealData, analysis, lenderMatches: supabaseMatches })
    }).then(r => r.json()).then(r => {
      if(r.success) {
        console.log('Synced to Supabase:', r.dealCode);
        const dcEl = document.getElementById('deal-code-badge');
        if(dcEl) { dcEl.textContent = r.dealCode; dcEl.style.display = 'inline-flex'; }
      }
    }).catch(e => console.warn('Supabase sync error:', e.message));
```
Replace the entire block with:
```js
    // Persistence now happens server-side inside capiq-analyze (deferred waitUntil).
    // The badge shows the client-generated code for reference only; the DB row's
    // deal_code is assigned by the column default and is not looked up here.
    const dcEl = document.getElementById('deal-code-badge');
    if (dcEl) { dcEl.textContent = enrichedDealData.dealCode; dcEl.style.display = 'inline-flex'; }
```

Also check L2310–2311 (`const supabaseMatches = deal.matches || []; const session = getSession();`) — `supabaseMatches` is now unused; remove that line. Keep `session` if the `increment_usage` fetch below still uses it (it does — leave `session`).

- [ ] **Step 3: Syntax + dup check**

Run: `npm run check`
Expected: CHECK 3 (inline `<script>` syntax in `app.html`) passes; CHECK 2 passes.

- [ ] **Step 4: Grep to confirm the second path is gone**

Run: `grep -n "capiq-save-deal" app.html`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add app.html
git commit -m "feat(deal-capture): app.html sends session token to capiq-analyze; drop capiq-save-deal

Single server-side save path now. Deal-code badge shows the client-generated
code (display-only; DB assigns its own). Removes the duplicate write that
would have double-inserted deal_submissions once both paths worked.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013gtwKXcTRykXJxmRxLRxsR"
```

---

### Task 7: Set the Netlify env var, deploy Phase 2, run the full smoke

**Files:** none (env + deploy + verification).

**Interfaces:**
- Consumes: Tasks 3–6 commits, Task 4 migration, Task 2's test lender credential.
- Produces: a live consolidated deal-capture path with real rows.

- [ ] **Step 1: Confirm Phase 1 is deployed**

Supabase MCP `list_edge_functions` — `capiq-lender-portal-v4` version is the Task 2 deploy (not the Step-1 rollback target). If not, STOP — Phase 1 must be live first (Global Constraints / spec §1.3).

- [ ] **Step 2: Set `SUPABASE_SERVICE_KEY` in Netlify**

Confirm current state first — GET the project's env vars (Netlify MCP `netlify-project-services-*` or the dashboard) or hit `https://underlytix.com/.netlify/functions/capiq-analyze?selftest=env` (the function already reports `SUPABASE_SERVICE_KEY: <bool>` in its selftest — check `capiq-analyze.js` L59–60 for the exact query string).

If unset: set `SUPABASE_SERVICE_KEY` on site `f7733dc6-b916-4bed-9ffc-da3a467142ad` to the project's `service_role` key (Supabase dashboard → Project Settings → API → `service_role`, or MCP `get_publishable_keys` is anon-only — the service key must come from the dashboard / user). **This value is a secret; do not echo it into logs or commits.**

**This step requires user action or explicit approval** (the service-role key is not available to this session by default).

- [ ] **Step 3: Merge the branch / deploy**

Merge `feat/deal-capture-consolidation` to `main` (PR or fast-forward per the user's preference), then run `push_site.bat` (or let Netlify auto-deploy from `main`). Wait for the Netlify deploy to reach `ready`.

- [ ] **Step 4: Smoke — a normal analysis still returns 200 (import didn't break the function)**

Submit one real deal through the investor app UI while logged in as a test investor, OR `POST /.netlify/functions/capiq-analyze` with a minimal valid `{dealData, prompt, token}`.
Expected: `200` with `{ success: true, analysis: {...} }` within ~15s. **If 502/500 — the `./lib/deal-mappers.mjs` import likely didn't bundle; check the Netlify function log, fix packaging, redeploy before continuing.**

- [ ] **Step 5: Smoke — the row set (spec §7)**

Within ~30s of Step 4, via Supabase MCP `execute_sql`:
```sql
select
  (select count(*) from deal_submissions where created_at > now() - interval '5 min') ds,
  (select count(*) from deal_scores    where scored_at  > now() - interval '5 min') sc,
  (select count(*) from borrowers      where created_at > now() - interval '5 min') b,
  (select count(*) from lender_matches where routed_at  > now() - interval '5 min') lm,
  (select count(*) from platform_events where created_at > now() - interval '5 min') pe;
```
Expected: `ds = 1`, `sc = 1`, `b = 1` (0 acceptable if the test investor's email matched an existing borrower), `lm = 4` (3 `non_qm` + 1 `both`), `pe >= 1` with `event_type = 'deal_analyzed'`.

Then inspect the deal row:
```sql
select deal_type, asset_type, deal_category, deal_code, investor_id, borrower_id,
       jsonb_typeof(ai_analysis) ai_type
from deal_submissions order by created_at desc limit 1;
```
Expected: `deal_type`/`asset_type` are enum values; `deal_code` starts `DL-`; `investor_id` non-null (logged in); `ai_type = 'object'`.

```sql
select jsonb_typeof(rationale_json) r, jsonb_typeof(risk_flags_json) f,
       total_fundability_score, score_band
from deal_scores order by scored_at desc limit 1;
```
Expected: `r = 'array'`, `f = 'array'`, score in 0–100, band ∈ {strong,conditional,hold}.

```sql
select distinct match_status from lender_matches where routed_at > now() - interval '5 min';
```
Expected: only `matched` and/or `conditional` — never `pending`.

- [ ] **Step 6: Smoke — no duplicate deal**

```sql
select count(*) from deal_submissions where created_at > now() - interval '5 min';
```
Expected: exactly `1` (proves the `capiq-save-deal` path is gone).

- [ ] **Step 7: Smoke — the deal shows in the lender portal**

Log into the lender portal as `portal@coastalcapital.com` / `SmokeTest!2026` (from Task 2) → the pipeline shows the new deal with its score and the borrower profile.

- [ ] **Step 8: Smoke — anonymous path**

Repeat Step 4 with `token: null`. Expected: `deal_submissions` row still written, `investor_id` null, matching `platform_events` row has `metadata->>'anonymous' = 'true'`.

- [ ] **Step 9: Smoke — failure observability**

Temporarily set `SUPABASE_SERVICE_KEY` to an invalid value (or point `SB` — no, don't edit code; use a bad env value), submit one analysis, expect a `platform_events` row `event_type = 'deal_save_failed'` **or** (if the events insert also fails) a `[capiq-save]` line in the Netlify function log. Restore the correct key immediately after. *(If flipping the env var is too disruptive, document this as verified-by-inspection instead.)*

- [ ] **Step 10: Clean up test data**

```sql
delete from lender_matches where routed_at  > now() - interval '30 min';
delete from deal_scores    where scored_at  > now() - interval '30 min';
delete from platform_events where created_at > now() - interval '30 min';
delete from deal_submissions where created_at > now() - interval '30 min';
delete from borrowers where created_at > now() - interval '30 min' and email like '%smoke%' ;
```
Adjust predicates to match exactly the test rows created; **do not delete the `e1000000…`/`e4000000…` seed rows.** Verify seed counts afterward (`deal_submissions` back to 6).

- [ ] **Step 11: Reset the test lender password**

Either restore `portal@coastalcapital.com` to its prior hash (if recorded) or notify the user it's set to `SmokeTest!2026` (now stored PBKDF2) so they can reset it.

---

### Task 8: Decommission `capiq-save-deal` and record loose ends

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-underlytix-deal-capture-consolidation-design.md` §8 (tick resolved items) — optional.

**Interfaces:** none.

- [ ] **Step 1: Confirm the consolidated path has written real rows in production**

After Task 7 and at least one real user-driven analysis (not just smoke), verify a `deal_analyzed` `platform_events` row exists with a real `user_id`. Wait for this evidence before deleting anything.

- [ ] **Step 2: Delete the `capiq-save-deal` edge function**

Supabase dashboard (Edge Functions → `capiq-save-deal` → delete) — there is no MCP delete tool. Confirm `grep -rn "capiq-save-deal" .` (excluding `node_modules`, `docs/`) returns nothing in code first.

- [ ] **Step 3: Open follow-up issues (or note on the PR)**

- `lender_matches` needs `UNIQUE (deal_id, lender_id)` + a dedupe strategy for repeat analyses of one deal.
- Instant IPA/LPA calculator persistence — decide now that this is stable.
- Full lender Supabase Auth migration + `LENDER_TOKEN_SECRET` isolation (spec §3.4).
- Get the ~30 unversioned deployed edge functions into the repo.
- `capiq-auth.js` (netlify) is dead code — `git rm`.

- [ ] **Step 4: Final commit (if spec §8 edited)**

```bash
git add docs/superpowers/specs/2026-09-10-underlytix-deal-capture-consolidation-design.md
git commit -m "docs: mark deal-capture consolidation items resolved"
```

---

## Self-Review

**Spec coverage:**
- §3.1 token signature → Task 1 Step 4 (`hmSign`/`gt`/`vt`) ✓
- §3.2 password hash + auto-upgrade → Task 1 Step 4–5 ✓
- §3.3 existing sessions drop to login → Task 2 Step 6 (verify reject) + relies on `lender.html:1067` (unchanged) ✓
- §3.4 shared-key trade-off → documented in spec; no code action; noted in Task 8 Step 3 ✓
- §3.5 deploy + rollback → Task 2 Steps 1–2, 6 ✓
- §4.1 migration → Task 4 ✓
- §4.2 step 1 token verify (deferred) → Task 5 Step 3 stage `investor`, inside the IIFE ✓
- §4.2 step 2 borrower upsert (null-email path) → Task 5 Step 3 stage `borrower` ✓
- §4.2 step 3 deal insert (no `deal_code`, enum mappers, `deal_category` from raw) → Task 5 Step 3 stage `deal` ✓
- §4.2 step 4 deal_scores (native jsonb, clamped) → Task 5 Step 3 stage `scores` ✓
- §4.2 step 5 lender_matches (`match_status` fixed) → Task 5 Step 3 stage `matches` ✓
- §4.2 step 6 platform_events → Task 5 Step 3 stage `events` ✓
- §4.3 port helpers → Task 3 ✓
- §4.4 app.html (token, remove call, badge) → Task 6 ✓
- §4.5 observability → Task 5 Steps 2–3 (console.error on missing key + catch; `deal_save_failed` row; `stage` tracking) ✓
- §4.6 decommission → Task 8 ✓
- §4.7 pre-flight (repo-vs-deployed, env var) → Task 7 Steps 1–2, 4 ✓
- §5 deploy order → Global Constraints + Task 7 Step 1 gate ✓
- §6 rollback → Task 2 Step 1 (version capture); revert paths are git-native ✓
- §7 test plan → Task 7 Steps 4–9 ✓
- §8 loose ends → Task 8 Step 3 ✓

**Placeholder scan:** no "TBD"/"handle appropriately"/"similar to". The one inline note in Task 5 Step 3 (`lender_fit_score` placeholder then overwrite) is explained with the reason and the ordering requirement. Task 7 Step 9 has a documented fallback ("verified-by-inspection") because flipping a prod env var may be too disruptive — this is a real conditional, not a placeholder.

**Type consistency:** `deal-mappers.mjs` exports named in Task 3 Interfaces match the import list in Task 5 Step 1 and the test import in Task 3 Step 1 (`clamp`, `mapDealType`, `mapAssetType`, `mapExperience`, `mapExperienceCount`, `mapExitStrategy`, `deriveDealCategory`, `scoreBand`, `estimateCollateral`, `estimateCashFlow`, `estimateBorrower`, `estimateExecution`, `buildRiskFlags`). Edge-fn helpers `gt`/`vt`/`newHash`/`verifyHash`/`legacyHash`/`hmSign`/`hmacKey` are consistent between Task 1 Step 4 and Step 5. `stage` string values (`init`/`investor`/`borrower`/`deal`/`scores`/`matches`/`events`) are set before each block and read in the single `catch`.

**Gaps:** none identified. `package.json` `test` script coordination with the parallel P0-3 workstream is called out in Task 3 Step 2.
