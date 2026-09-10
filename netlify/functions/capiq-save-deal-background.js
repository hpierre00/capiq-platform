// Deal persistence, decoupled from capiq-analyze's 30s budget.
//
// capiq-analyze runs the Claude call (15-29s) then, inside the SAME 30s Netlify
// function budget, used to run these Supabase writes in context.waitUntil().
// After a real analysis there was ~2-5s of wall clock left — not enough for six
// sequential PostgREST round-trips, so the container was frozen mid-write
// (borrower inserted, deal_submissions never reached, catch never ran). This is
// a Netlify BACKGROUND function: 202 to the caller immediately, then up to 15
// minutes of its own budget to finish. capiq-analyze fires it the same way it
// fires resend-email / notion-sync, and a failure to invoke it never touches
// the analysis response.
//
// Invoked by capiq-analyze only: POST { dealData, analysis, token }, with an
// x-internal-key header equal to SUPABASE_SERVICE_KEY (both functions have it).
//
// Every form value that lands in a CHECK-constrained column goes through a
// mapper in ./lib/deal-mappers.mjs.

import {
  clamp, mapDealType, mapAssetType, mapExperience, mapExperienceCount,
  mapExitStrategy, deriveDealCategory, scoreBand,
  estimateCollateral, estimateCashFlow, estimateBorrower, estimateExecution,
  buildRiskFlags,
} from "./lib/deal-mappers.mjs";

const SUPABASE_URL = "https://mxyepucitjzleaziizkr.supabase.co";

export default async (req) => {
  const SVC_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
  if (!SVC_KEY) {
    console.error("[capiq-save] SUPABASE_SERVICE_KEY unset — deal persistence disabled");
    return new Response(null, { status: 202 });
  }
  if (req.headers.get("x-internal-key") !== SVC_KEY) {
    return new Response("forbidden", { status: 403 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const d = body.dealData || {};
  const analysis = body.analysis || {};
  const token = body.token || null;

  const H = { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, "Content-Type": "application/json" };
  let stage = "init";
  let dealCodeForLog = null;
  try {
    // 1. Resolve the investor from the session token. Any failure or a
    //    legacy/absent token -> anonymous save (investor_id null).
    stage = "investor";
    let investorId = null;
    if (token && token.split(".").length === 3) {
      const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SVC_KEY, Authorization: `Bearer ${token}` },
      });
      if (ur.ok) {
        const au = await ur.json();
        if (au && au.email) {
          const ir = await fetch(
            `${SUPABASE_URL}/rest/v1/investors?select=id&email=eq.${encodeURIComponent(au.email)}`,
            { headers: H }
          );
          if (ir.ok) { const rows = await ir.json(); investorId = (rows[0] && rows[0].id) || null; }
        }
      }
    }

    // 2. Upsert the borrower. Dedupe by email where present; a null email
    //    (anonymous) inserts a fresh row (plain UNIQUE allows many NULLs).
    stage = "borrower";
    let borrowerId = null;
    const borrowerRow = {
      borrower_name: d.investorName || "Unknown",
      email: d.investorEmail || null,
      phone: d.investorPhone || null,
      fico: parseInt(d.creditScore, 10) || null,
      experience_level: mapExperience(d.investorExperience),
      experience_count: mapExperienceCount(d.investorExperience),
      borrower_type: "individual",
      updated_at: new Date().toISOString(),
    };
    const bRes = await fetch(
      d.investorEmail ? `${SUPABASE_URL}/rest/v1/borrowers?on_conflict=email` : `${SUPABASE_URL}/rest/v1/borrowers`,
      {
        method: "POST",
        headers: { ...H, Prefer: d.investorEmail ? "resolution=merge-duplicates,return=representation" : "return=representation" },
        body: JSON.stringify(borrowerRow),
      }
    );
    if (bRes.ok) { const rows = await bRes.json(); borrowerId = (rows[0] && rows[0].id) || null; }
    else console.error("[capiq-save] borrower upsert failed:", bRes.status, await bRes.text().catch(() => ""));

    // 3. Insert deal_submissions. deal_code is deliberately NOT sent — the
    //    column is NOT NULL + defaulted + UNIQUE; a client value would
    //    reintroduce the silent-insert-failure class this change removes.
    stage = "deal";
    const dealCategory = deriveDealCategory(d.dealType); // raw form value, before mapDealType
    const dealRes = await fetch(`${SUPABASE_URL}/rest/v1/deal_submissions`, {
      method: "POST",
      headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify({
        borrower_id: borrowerId,
        deal_type: mapDealType(d.dealType, d.market),
        asset_type: mapAssetType(d.propertyType, d.market),
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
        exit_strategy: mapExitStrategy(d.dealType, d.market),
        deal_category: dealCategory,
        investor_id: investorId,
        investor_name: d.investorName || null,
        investor_email: d.investorEmail || null,
        ai_analysis: analysis,
      }),
    });
    if (!dealRes.ok) {
      console.error("[capiq-save] deal insert failed:", dealRes.status, await dealRes.text().catch(() => ""));
      throw new Error("deal insert failed");
    }
    const [savedDeal] = await dealRes.json();
    if (!savedDeal || !savedDeal.id) throw new Error("deal insert returned no id");
    dealCodeForLog = savedDeal.deal_code || null;

    // 4. Route lenders by qm_category. lender_id must be lender_profile_id,
    //    not lender_users.id (the get_deals read path filters on the former).
    stage = "route";
    const fund = clamp(Number(analysis.fundabilityScore) || 0, 0, 100);
    const lendersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lender_users?select=id,lender_profile_id,qm_category&or=(qm_category.eq.${dealCategory},qm_category.eq.both)&limit=50`,
      { headers: H }
    );
    const lenders = lendersRes.ok ? await lendersRes.json() : [];
    const routable = lenders.filter((l) => l.lender_profile_id);

    // 5. Insert deal_scores. jsonb columns get native arrays, not strings.
    //    Every numeric score is clamped to the 0..100 CHECK range.
    stage = "scores";
    const scoresRes = await fetch(`${SUPABASE_URL}/rest/v1/deal_scores`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        deal_id: savedDeal.id,
        total_fundability_score: fund,
        score_band: scoreBand(fund),
        collateral_strength_score: clamp(estimateCollateral(d), 0, 100),
        cash_flow_strength_score: clamp(estimateCashFlow(d), 0, 100),
        borrower_strength_score: clamp(estimateBorrower(d), 0, 100),
        execution_risk_score: clamp(estimateExecution(d), 0, 100),
        lender_fit_score: clamp(routable.length * 20, 0, 100),
        rationale_json: [
          { section: "executive_summary", text: analysis.executiveSummary || "" },
          { section: "strengths_risks", text: analysis.strengthsAndRisks || "" },
          { section: "score_breakdown", text: analysis.scoreBreakdown || "" },
          { section: "structuring", text: analysis.structuringRecommendations || "" },
          { section: "next_steps", text: analysis.nextSteps || "" },
          { section: "market_context", text: analysis.marketContext || "" },
        ],
        risk_flags_json: buildRiskFlags(d, analysis),
        scoring_version: "v2.0",
      }),
    });
    if (!scoresRes.ok) console.error("[capiq-save] deal_scores insert failed:", scoresRes.status, await scoresRes.text().catch(() => ""));

    // 6. Insert lender_matches. match_status must be matched/conditional/rejected
    //    — the prior 'pending' value violated the CHECK (23514).
    stage = "matches";
    if (routable.length) {
      const matchRows = routable.map((l) => ({
        deal_id: savedDeal.id,
        lender_id: l.lender_profile_id,
        match_status: fund >= 80 ? "matched" : "conditional",
        interest_level: "pending",
        match_score: fund,
        deal_score_val: fund,
        routed_at: new Date().toISOString(),
      }));
      const mRes = await fetch(`${SUPABASE_URL}/rest/v1/lender_matches`, {
        method: "POST", headers: H, body: JSON.stringify(matchRows),
      });
      if (!mRes.ok) console.error("[capiq-save] lender_matches insert failed:", mRes.status, await mRes.text().catch(() => ""));
    }

    // 7. Success event.
    stage = "events";
    await fetch(`${SUPABASE_URL}/rest/v1/platform_events`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        event_type: "deal_analyzed",
        user_type: "investor",
        user_id: investorId,
        metadata: {
          deal_code: savedDeal.deal_code, deal_id: savedDeal.id,
          score: fund, verdict: analysis.dealScore, deal_type: d.dealType,
          state: d.state, lender_matches: routable.length, anonymous: investorId == null,
        },
      }),
    }).catch(() => {});

    console.log("[capiq-save] persisted", savedDeal.deal_code, "investor", investorId || "(anon)", "matches", routable.length);
  } catch (e) {
    console.error("[capiq-save] deal persistence failed at stage", stage, ":", e && e.message, e && e.stack);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/platform_events`, {
        method: "POST", headers: H,
        body: JSON.stringify({
          event_type: "deal_save_failed",
          user_type: "investor",
          metadata: { stage, error: String((e && e.message) || e), deal_code: dealCodeForLog },
        }),
      });
    } catch (_) { /* Supabase-wide failure — the console.error above is the signal */ }
  }

  return new Response(null, { status: 202 });
};

export const config = { background: true };
