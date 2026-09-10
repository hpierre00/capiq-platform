# Underlytix — Deal-Capture Consolidation + Lender-Portal Auth Hardening

**Date:** 2026-09-10
**Status:** Approved (design) — pending implementation plan
**Repo:** `hpierre00/capiq-platform`
**Supabase project:** `mxyepucitjzleaziizkr`
**Netlify site:** `f7733dc6-b916-4bed-9ffc-da3a467142ad` (capiq-platform → underlytix.com)

---

## 0. Execution-time corrections (2026-09-10)

The original §1 background was written from the **repo** copies of the edge
functions. During execution, the **deployed** functions were checked directly
and three premises turned out wrong. This section overrides §1–§4 where noted;
the rest of the design stands.

1. **The forgeable lender token is already fixed in production.** Deployed
   `capiq-lender-portal-v4` (v4, updated ~2026-08) already uses real
   HMAC-SHA256 (key from `SUPABASE_SERVICE_ROLE_KEY`, domain
   `'capiq-lender-legacy-token-v1'`) and PBKDF2-210k with login auto-upgrade.
   Verified live: a forged old-format token returns `{valid:false}`. **The
   repo copy was stale** — hardened directly on the deployed function weeks
   ago, never committed back (same pattern as §8's "~30 unversioned
   functions"). → **§1.2 is obsolete.** Workstream 1 becomes: (a) commit the
   repo copy so it matches prod (done, `d1ff0ef`), (b) redeploy that
   repo-synced copy for one marginal improvement — constant-time signature
   compare in `vt()` instead of `!==`. Key derivation + domain string are
   identical to the deployed version, so **redeploy causes zero session
   disruption** — §3.3's "4 lenders re-login" already happened weeks ago.

2. **`SUPABASE_SERVICE_KEY` is set in Netlify.** `capiq-analyze?selftest=env`
   → `"SUPABASE_SERVICE_KEY": true`. → **§1.1 root-cause "Path A never runs"
   and §4.7 step 2 are obsolete.** Path A's `supabaseTask` executes on every
   real analysis today.

3. **Path A's real failure is the CHECK constraints, live now.** With the key
   set, Path A's `deal_submissions` insert runs and fails `23514` on
   `deal_type: d.dealType` (`"Fix & Flip"` ∉ enum), swallowed by
   `if (!dealInsert.ok) return;`. It has not *visibly* failed only because
   real deal submissions are near-zero. → confirms §4.2/§4.3 (the mappers)
   are load-bearing, not defensive; the "never executed" reasoning from the
   spec review was wrong about the mechanism, not the fix.

4. **`capiq-analyze.js` deployed matches the repo** (BUILD
   `2026-08-05-client-prompt-cap-fix`). §4.7 step 1 pre-flight: satisfied.

Net effect on scope: Workstream 1 shrinks to a repo-sync commit + an
equivalent redeploy. Workstream 2 is unchanged and still required.

---

## 1. Background

Two P0 problems in the CapIQ / Underlytix platform, plus the discovery that
drove the design:

### 1.1 The deal-capture pipeline has never persisted a real row

The investor app's "Analyze Deal" flow computes a deal analysis server-side
(`capiq-analyze`), and the client shows it and writes it to `localStorage`.
Two *separate* server-side paths then attempt to persist it to Supabase:

| | Path A — `netlify/functions/capiq-analyze.js` | Path B — `capiq-save-deal` (Supabase edge fn) |
|---|---|---|
| **Trigger** | `context.waitUntil()` after the AI call, gated on `SUPABASE_SERVICE_KEY` env var | `fetch()` from `app.html:2318`, fire-and-forget |
| **`borrowers`** | — | upsert by email (**broken:** `onConflict:'email'` with no unique constraint → `42P10`) |
| **`deal_submissions`** | insert *with* `investor_id/name/email`, `ai_analysis`, derived `deal_category` | insert *without* investor linkage, `deal_category`, or `ai_analysis` |
| **`deal_scores`** | — | insert (only path that does) |
| **`lender_matches`** | routed by `qm_category` → `lender_profile_id` (`lender_id` bug already fixed here) | crude fuzzy name match vs `lender_profiles` |
| **`platform_events`** | — | insert |

Live state (2026-09-10): `deal_submissions` = 6 rows, **all seed** (0 with
`ai_analysis`, 0 with `investor_id`); `platform_events` = 0; `borrowers` = 3
(seed, all `email IS NULL`). **Neither path has ever written a real row.** If
both worked they would double-insert `deal_submissions` and `lender_matches`
on every analysis.

Root causes:
- **Path A** never runs — `SUPABASE_SERVICE_KEY` has never been set in Netlify.
- **Path B** always throws at step 1 — no unique constraint on `borrowers.email`.

### 1.2 `capiq-lender-portal-v4` auth is weak and the token is forgeable

- **Token signature** `hm()` is a 32-bit non-cryptographic rolling hash
  (`h = ((h<<5)-h)+c; ... Math.abs(h).toString(36) + len.toString(36)`).
  A valid lender-portal token for **any** `lender_profile_id` can be brute-
  forced in milliseconds, exposing that lender's matched deals + borrower PII
  (name, FICO, experience) via `get_deals`.
- **Password hash** `hp()` is `SHA256(password + 'capiq-lender-salt-2026')` —
  one static global salt, unsalted-per-user, fast hash.
- `lender_users.supabase_uid` exists but is `0/4` populated — the Supabase Auth
  migration done for investors (`capiq-auth-v3`, May 2026) and realtors
  (`capiq-realtor-auth-v5`) was never done for lenders.

`capiq-realtor-auth-v5` is the in-repo reference for "done correctly":
Supabase Auth primary + PBKDF2 fallback with auto-upgrade + HMAC token key
derived from `SUPABASE_SERVICE_ROLE_KEY`.

### 1.3 Sequencing constraint (decided)

The `borrowers.email` migration turns Path B's write path back on as a side
effect (it fixes the `onConflict` bug). The moment deal capture works, real
borrower PII flows into `deal_submissions` / `borrowers` / `lender_matches` —
the exact tables behind the forgeable lender token. Therefore **the lender-
portal auth fix ships first, or in the same release — never after** the deal-
capture change.

---

## 2. Scope

**In scope**

1. Harden `capiq-lender-portal-v4` auth (token signature + password hash),
   "Option B": no full Supabase Auth migration for lenders yet.
2. Consolidate deal capture onto **Path A** (`capiq-analyze.js`); make it
   write the complete row set correctly; remove Path B's caller.
3. `borrowers.email` unique-constraint migration.
4. Minimal write-failure observability for the consolidated path.

**Out of scope**

- Calc-function unit tests (P0-3) — owned separately, no edits to
  `app.html` / `lender.html` from that work.
- Full Supabase Auth migration for lenders (deferred to a deliberate
  cross-portal pass).
- Persisting the instant IPA/LPA calculator runs (`ipaComputeDecision` /
  `lpaComputeDecision`) — open question, deferred until this is stable.
- Getting the other ~30 deployed edge functions into the repo.
- De-duplicating `deal_submissions` across repeat analyses of one deal.

---

## 3. Workstream 1 — `capiq-lender-portal-v4` auth hardening

**File:** `supabase/functions/capiq-lender-portal-v4/index.ts` (deployed via
Supabase MCP `deploy_edge_function`; repo copy updated to match).

### 3.1 Token signature

Replace `hm()` with real HMAC-SHA256. Signing key derived from
`SUPABASE_SERVICE_ROLE_KEY` using the exact pattern in
`capiq-realtor-auth-v5`:

```
rootKey  = importKey('raw', utf8(SUPABASE_SERVICE_ROLE_KEY), HMAC/SHA-256, ['sign'])
derived  = sign('HMAC', rootKey, utf8('capiq-lender-legacy-token-v1'))
hmacKey  = importKey('raw', derived, HMAC/SHA-256, ['sign','verify'])
signature = hex(sign('HMAC', hmacKey, utf8(payloadB64)))
```

- Token format stays `<base64url(payload)>.<signature>`. **Payload shape is
  unchanged** (`{ id, email, lender_profile_id, role, qm_category, exp }`) so
  `get_deals` / `update_match` / `verify` need no changes beyond calling the
  new verifier.
- `gt()` and `vt()` become `async` (WebCrypto). Propagate `await` to all call
  sites.

### 3.2 Password hash

Adopt `capiq-realtor-auth-v5`'s `newHash()` / `verifyHash()` verbatim:
- `newHash`: PBKDF2-SHA256, 210 000 iterations, 16-byte random salt,
  format `pbkdf2$<iterations>$<b64 salt>$<b64 hash>`.
- `verifyHash`: if stored value starts with `pbkdf2$`, PBKDF2 + constant-time
  compare; else fall back to legacy `SHA256(pw + 'capiq-lender-salt-2026')`.
- **Auto-upgrade:** on successful `login`, `change_password`, `reset_password`
  — if the stored hash is not `pbkdf2$`, rehash with `newHash()` and
  `UPDATE lender_users SET password_hash = …`.
- Keep the legacy `hp()` function (used only by `verifyHash`'s fallback
  branch). Delete `SALT`/`JWT_SECRET` constants once `hm()` is gone; keep the
  legacy salt string inside `hp()`.

### 3.3 Existing sessions

Old weak-signature tokens **will not verify** against the new HMAC. On the
lender portal's load-time `verify` call, `lender.html:1067` already does
`clearLenderSession(); showLenderLoginView();` on `!data.valid` — so the 4
current lender users are dropped to the login screen once and re-authenticate.
**No backward-compatible acceptance of weak tokens** (that would preserve the
forgery vector).

### 3.4 Accepted trade-off (documented, not fixed here)

Deriving the token HMAC key from `SUPABASE_SERVICE_ROLE_KEY` matches the
existing realtor/investor pattern and keeps the three auth functions
consistent. Consequence: a leak of `SUPABASE_SERVICE_ROLE_KEY` from **any**
of the three auth functions simultaneously enables (a) token forgery for all
portals and (b) full-DB service-role access. A dedicated
`LENDER_TOKEN_SECRET` env var would isolate (a) from (b); deferred to the
same future pass that does the full lender Supabase Auth migration, to avoid
diverging the three functions piecemeal.

### 3.5 Deploy

1. Update repo copy.
2. `deploy_edge_function` (`capiq-lender-portal-v4`) — **explicit approval at
   this step.**
3. Smoke: log in as a lender (`portal@coastalcapital.com` et al. — password
   reset if unknown), confirm `get_deals` returns, confirm a hand-forged
   old-format token now returns `{valid:false}`.
4. Rollback: redeploy the previous version from Supabase's function history.

---

## 4. Workstream 2 — consolidate deal capture on Path A

### 4.1 Migration — `borrowers.email` unique constraint

Via Supabase MCP `apply_migration`, name `add_borrowers_email_unique`:

```sql
ALTER TABLE borrowers ADD CONSTRAINT borrowers_email_key UNIQUE (email);
```

- Plain `UNIQUE` — Postgres permits multiple `NULL`s, so anonymous deals
  (no borrower email) still insert fresh rows; real emails de-duplicate.
- **Safety verified 2026-09-10:** all existing `borrowers.email` are `NULL`;
  zero duplicate non-null values.
- Side effect (acknowledged): this also repairs Path B's `onConflict:'email'`
  bug. Path B's caller is removed in §4.4 so this does not cause double writes,
  but see §6 on rollback.

### 4.2 `capiq-analyze.js` — extend `supabaseTask`

All work below happens **inside** the existing `context.waitUntil()` /
`supabaseTask` deferred block — never on the response critical path (the
function already runs against a hard 30 s Netlify ceiling; the AI call
consumes most of it).

Current `supabaseTask` (≈ lines 405–470) does: derive `deal_category` →
insert `deal_submissions` → query lenders → insert `lender_matches`. New
sequence:

1. **Resolve investor (token verify).** Read `body.token`. If present and it
   looks like a Supabase JWT (`token.split('.').length === 3`):
   `GET {SUPABASE_URL}/auth/v1/user` with `Authorization: Bearer <token>` +
   `apikey: <SUPABASE_SERVICE_KEY>` (the key already available to the
   function; GoTrue accepts it for user introspection). Raw `fetch`, matching
   this file's style — no `supabase-js` import. On `200`, take `email`, then
   `GET /rest/v1/investors?select=id,name,email&email=eq.<email>` → `investor_id`.
   Legacy HMAC token, missing token, or any failure → `investor_id = null`
   (anonymous save — **decided**). Never throw out of this step.

2. **Upsert borrower.** Port `capiq-save-deal`'s field mapping:
   - `borrower_name`  ← `d.investorName || 'Unknown'`
   - `email`          ← `d.investorEmail || null`
   - `phone`          ← `d.investorPhone || null`
   - `fico`           ← `parseInt(d.creditScore, 10) || null`  *(integer column)*
   - `experience_level` ← `mapExperience(d.investorExperience)`  *(CHECK: first_time/emerging/experienced/veteran)*
   - `experience_count` ← `mapExperienceCount(d.investorExperience)`
   - `borrower_type`  ← `'individual'`  *(CHECK: individual/llc/corporation/trust)*
   - `updated_at`     ← now

   If `email` is non-null: `POST /rest/v1/borrowers` with
   `Prefer: resolution=merge-duplicates,return=representation` and
   `on_conflict=email`. If `email` is null: plain `POST` (new row). Capture
   `borrower_id`. Failure here → log (§4.5) and continue with
   `borrower_id = null` (FK is nullable).

3. **Insert `deal_submissions`.** Keep the current fields, with corrections:
   - **Do NOT send `deal_code`.** Let the column default assign it (it is
     `NOT NULL`, defaulted, and `UNIQUE` — a client-supplied value re-creates
     the silent-insert-failure class this whole workstream exists to remove).
   - `deal_type`   ← `mapDealType(d.dealType)`   *(CHECK: fix_flip/rental/cash_out/bridge/construction/commercial)*
   - `asset_type`  ← `mapAssetType(d.propertyType)`  *(CHECK: sfr/2_4_unit/multifamily/commercial/mixed_use/land)*
   - `exit_strategy` ← `mapExitStrategy(d.dealType)`  *(no CHECK, but map for consistency)*
   - `deal_category` ← derive from **raw** `d.dealType` (lower-cased) against
     `['conventional','fha','va','usda','jumbo']` → `'qm'` else `'non_qm'`.
     Derive **before** `mapDealType` runs (mapped values never match the qm
     list). In the current investor form this is always `'non_qm'`; kept for
     correctness/future-proofing.
   - `borrower_id` ← from step 2
   - `investor_id` / `investor_name` / `investor_email` ← from step 1
     (fall back to `d.investorName` / `d.investorEmail` for the name/email
     display fields even when `investor_id` is null)
   - `ai_analysis` ← `analysis` (native JSON object — column is `jsonb`)
   - numeric fields ← `parseFloat(...) || null` as today
   `Prefer: return=representation` → capture `deal.id`.

4. **Insert `deal_scores`** (new — port `capiq-save-deal`'s estimators):
   - `deal_id` ← step 3
   - `total_fundability_score` ← `clamp(Number(analysis.fundabilityScore) || 0, 0, 100)`  *(CHECK 0–100)*
   - `score_band` ← `score >= 65 ? 'strong' : score >= 45 ? 'conditional' : 'hold'`  *(CHECK: strong/conditional/hold)*
   - `collateral_strength_score` / `cash_flow_strength_score` /
     `borrower_strength_score` / `execution_risk_score` / `lender_fit_score`
     ← ported `estimateCollateral` / `estimateCashFlow` / `estimateBorrower`
     / `estimateExecution` / `min(lenderCount*20,100)`, each `clamp(_,0,100)`
   - `rationale_json` ← **native array** (not `JSON.stringify`) — column is `jsonb`
   - `risk_flags_json` ← **native array** (ported `buildRiskFlags`) — `jsonb`
   - `scoring_version` ← `'v2.0'`
   Failure here → log (§4.5), do not abort the rest.

5. **Insert `lender_matches`.** Fix Path A's own latent bug:
   - `match_status` ← `matchScore >= 80 ? 'matched' : 'conditional'`
     **(current code writes `'pending'`, which violates
     `lender_matches_match_status_check` — matched/conditional/rejected only)**
   - `interest_level` ← `'pending'` (valid for this column) — unchanged
   - `match_score` / `deal_score_val` ← `clamp(Number(analysis.fundabilityScore)||0, 0, 100)`
   - `deal_id`, `lender_id` (= `lender_profile_id`), `routed_at` — unchanged
   - Keep the existing `qm_category` routing query
     (`or=(qm_category.eq.<cat>,qm_category.eq.both)`) and the
     `l.lender_profile_id` filter.
   - Known gap, out of scope: no unique on `(deal_id, lender_id)`, so a
     re-analysis of the same deal creates a new `deal_id` and a fresh match
     set (no duplicates in practice); flagged for a later dedupe pass.

6. **Insert `platform_events`** (new):
   - `event_type` ← `'deal_analyzed'`
   - `user_type` ← `'investor'`
   - `user_id` ← `investor_id` (nullable)
   - `metadata` ← **native object** (jsonb): `{ deal_code, deal_id, score,
     verdict: analysis.dealScore, deal_type: d.dealType, state: d.state,
     lender_matches: routable.length, anonymous: investor_id == null }`

### 4.3 Port target — mapping helpers

Copy these from `capiq-save-deal` into `capiq-analyze.js` (adjust to its
style): `mapDealType`, `mapAssetType`, `mapExperience`, `mapExperienceCount`,
`mapExitStrategy`, `estimateCollateral`, `estimateCashFlow`,
`estimateBorrower`, `estimateExecution`, `buildRiskFlags`. Add a small
`clamp(n, lo, hi)`.

### 4.4 `app.html`

- **Send the session token to `capiq-analyze`** (≈ line 2290):
  `body: JSON.stringify({ dealData: enrichedDealData, prompt: analysisPrompt, token: getSession()?.token || null })`.
- **Remove the `capiq-save-deal` fetch and its callback** (lines 2318–2327).
- **Badge:** `deal-code-badge` currently shows `r.dealCode` from
  `capiq-save-deal`'s response. Replace with the already-client-generated
  `enrichedDealData.dealCode` (line 2270), set right after `renderResult(...)`.
  This value is **display-only** and is never written to the DB
  (§4.2 step 3). Accept that the badge's code and the DB row's `deal_code`
  differ; the badge is a UX affordance, not an identifier the user can look
  up server-side today.

### 4.5 Observability (new)

The entire reason this workstream exists is a silent failure that went
undetected for ~4.5 months. Minimum viable signal:

- **Missing-key branch:** when `SUPABASE_SERVICE_KEY` is unset, replace the
  silent `Promise.resolve()` with
  `console.error('[capiq-save] SUPABASE_SERVICE_KEY unset — deal persistence disabled')`
  (still non-fatal).
- **`catch` block:** `console.error('[capiq-save] deal persistence failed:', e?.message, e?.stack)`
  (was `console.warn`), **plus** a best-effort
  `POST /rest/v1/platform_events` with
  `{ event_type: 'deal_save_failed', user_type: 'investor',
     metadata: { stage, error: e?.message, deal_code } }` where `stage` names
  the step that threw (borrower / deal / scores / matches / events). This
  insert is itself wrapped so it cannot throw; if the failure is
  Supabase-wide it will also fail, but the `console.error` still fires in the
  Netlify function log.
- Each numbered step in §4.2 sets a local `stage` string before its
  `fetch` so the catch can report where it died.

### 4.6 `capiq-save-deal` decommission

- Remove the caller in this change (§4.4).
- **Leave the function deployed** for one release as rollback insurance.
- Delete it (Supabase dashboard / MCP) in a follow-up once the consolidated
  path is confirmed writing real rows. Track as a loose end.

### 4.7 Pre-flight (implementation plan must include)

1. **Confirm the deployed `capiq-analyze` matches the repo copy**
   (`netlify/functions/capiq-analyze.js`) before editing — Netlify functions
   deploy from git, but verify (e.g. `?selftest`/`BUILD` marker) so we are
   not editing a stale base.
2. **Set `SUPABASE_SERVICE_KEY` in Netlify** (site `f7733dc6-…`) to the
   project service-role key. This is a **gating item** — almost certainly the
   sole reason Path A has never executed. Without it, everything in §4.2 is
   dead code. (Edge functions get `SUPABASE_SERVICE_ROLE_KEY` injected
   automatically; the Netlify function uses the differently-named
   `SUPABASE_SERVICE_KEY` and must be set manually.)

---

## 5. Deployment order

1. **WS1** — deploy hardened `capiq-lender-portal-v4` (Supabase MCP).
   Verify existing lender can re-login; forged old token rejected.
2. **WS2 migration** — `apply_migration` `add_borrowers_email_unique`.
3. **WS2 env** — set `SUPABASE_SERVICE_KEY` in Netlify.
4. **WS2 code** — commit `capiq-analyze.js` + `app.html` changes; ship via the
   normal git → `push_site.bat` → Netlify flow (or PR + merge).
5. **Smoke** (§7). Then schedule `capiq-save-deal` deletion.

WS1 must not land *after* step 2/3. Steps 1 and 2–4 may be one release.

---

## 6. Rollback

| Change | Rollback | Resulting state |
|---|---|---|
| `capiq-lender-portal-v4` | Redeploy previous version from Supabase function history | Known-good (weak token restored — accept transient) |
| `borrowers_email_key` migration | `ALTER TABLE borrowers DROP CONSTRAINT borrowers_email_key` | Known-good |
| `capiq-analyze.js` + `app.html` commit | `git revert` | **Degraded-but-functional, not known-good:** Path B's caller is restored and — because the migration already fixed its `onConflict` bug — Path B now *works*, but still has (a) values double-JSON-encoded into `rationale_json` / `risk_flags_json`, (b) no `investor_id` / `deal_category` / `ai_analysis`, (c) crude fuzzy lender matching. Acceptable as a short-lived fallback only. |
| `SUPABASE_SERVICE_KEY` | Unset it | Path A silent again (but now `console.error` says so) |

---

## 7. Test / verification plan

Unit tests for the calc functions are a separate workstream. For this work:

**Post-deploy smoke (manual, one pass):**
1. Log into the investor app, run one real "Analyze Deal" with a full form
   (name, email, credit, experience, address, loan terms).
2. Expect exactly **one** new row in each of `borrowers`, `deal_submissions`,
   `deal_scores`, `platform_events` (`deal_analyzed`), and **no duplicate**
   `deal_submissions`.
3. `deal_submissions`: `investor_id` populated, `borrower_id` populated,
   `deal_type` / `asset_type` are enum-valid, `ai_analysis` is a JSON object,
   `deal_code` auto-assigned.
4. `deal_scores`: `rationale_json` / `risk_flags_json` are JSON **arrays**
   (not strings), `total_fundability_score` in 0–100, `score_band` enum-valid.
5. `lender_matches`: one row per `non_qm` lender + the `both` admin (4 today),
   `match_status` ∈ {matched, conditional}.
6. Log into the lender portal → the new deal appears in the pipeline with its
   score and borrower profile.
7. Negative: submit an analysis **logged out** (if reachable) → row still
   written, `investor_id` null, `platform_events.metadata.anonymous = true`.
8. Negative: hand-craft an old-format lender token → `verify` → `{valid:false}`.
9. Force one write failure (e.g. temporarily bad key) → confirm a
   `deal_save_failed` `platform_events` row and a `[capiq-save]` line in the
   Netlify function log.

**Regression:** existing investor login (`capiq-auth-v3`) and realtor login
(`capiq-realtor-auth-v5`) unaffected — not touched. `get_deals` /
`update_match` payloads unchanged.

---

## 8. Open items tracked (not resolved here)

- Delete `capiq-save-deal` after the consolidated path is confirmed live.
- Instant IPA/LPA calculator persistence — decide once §4 is stable.
- `lender_matches` needs a `UNIQUE (deal_id, lender_id)` + dedupe strategy
  for repeat analyses.
- Full lender Supabase Auth migration + `LENDER_TOKEN_SECRET` isolation.
- Get the ~30 unversioned deployed edge functions into the repo.
- `investors` / `realtor_users` / `lender_users` still carry legacy
  `password_hash` for un-migrated users (1/4, 3/6, 0/4 migrated).
