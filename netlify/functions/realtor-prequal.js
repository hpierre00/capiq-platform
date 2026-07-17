// Realtor Client Prequalification Engine
// Guidelines-accurate: 2025/2026 conforming limits, FHA, DSCR, Hard Money, Non-QM
// Data is provided by realtor — we apply rules, not verify documents

export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });

  try {
    const ANTHROPIC_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
    const SUPABASE_URL = "https://mxyepucitjzleaziizkr.supabase.co";
    const REALTOR_AUTH_FN = `${SUPABASE_URL}/functions/v1/capiq-realtor-auth-v5`;
    const SVC_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");

    const body = await req.json();
    const { action, token, messages, clientData, successUrl, cancelUrl } = body;
    const REALTOR_PRICE_ID = 'price_1TcCwDRAfobZUNrFwqUxc1hM';
    const STRIPE_SECRET = Netlify.env.get("STRIPE_SECRET_KEY") || "";

    // ── CHAT: conversational prequal intake ──────────────────────────────────
    if (action === "chat") {
      if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

      // Guidelines reference injected into system prompt — updated for 2025/2026
      const GUIDELINES = `
LOAN LIMITS (2025/2026 — use these exactly):
- Conforming (Fannie/Freddie): $806,500 standard, up to $1,209,750 high-cost areas
- FHA: varies by county; standard $524,225, high-cost up to $1,209,750
- VA: no loan limit for eligible veterans with full entitlement
- Jumbo: any loan above conforming limit
- DSCR: typically $150k–$3M depending on lender

DTI LIMITS:
- Conventional: front-end ≤28%, back-end ≤45% (up to 50% with strong compensating factors: 20%+ down, 740+ credit, 6+ months reserves)
- FHA: front-end ≤31%, back-end ≤43% standard; up to 57% with AUS approval and compensating factors
- VA: no front-end limit; back-end ≤41% guideline, higher with residual income
- Jumbo: back-end ≤43% typically, stricter with some lenders
- DSCR loans: NO personal income/DTI required — rental income / PITIA ≥ 1.0 (most lenders want 1.1–1.25)
- Bank statement loans: 12–24 months bank statements, no W-2, DTI varies by lender

DOWN PAYMENT / LTV:
- Conventional: 3% (first-time, HomeReady/HomePossible), 5% standard, 20% to avoid PMI
- FHA: 3.5% with 580+ credit; 10% with 500–579 credit
- VA: 0% down for eligible veterans
- USDA: 0% down, rural areas only
- Jumbo: 10–20% typically, varies by lender
- Hard money / bridge: 10–35% depending on ARV vs purchase, typically 65–75% LTV or 70–80% of ARV
- DSCR: 20–25% down typical, up to 80% LTV
- Fix & Flip: purchase + rehab, typically 90% of purchase + 100% of rehab up to 70% ARV

CREDIT SCORE MINIMUMS:
- Conventional: 620 minimum, 740+ for best rates
- FHA: 580 for 3.5% down; 500–579 for 10% down
- VA: no official minimum, lenders typically require 580–620
- Jumbo: 700–720 minimum, most require 740+
- DSCR: 660–680 minimum, 700+ preferred
- Hard money: 600+ (some lenders 580+, asset-based not credit-based)
- Bank statement / Non-QM: 620–640 minimum

EMPLOYMENT TYPES → LOAN PRODUCTS:
- W-2 employed 2+ years → Conventional, FHA, VA, USDA, Jumbo
- Self-employed 2+ years (strong returns) → Conventional, FHA, Jumbo
- Self-employed (<2 years or complex returns) → Bank statement loan, Non-QM
- 1099 contractor → Bank statement loan, or conventional if 2yr history
- Investor (rental income) → DSCR (no personal income needed)
- Investor (flip/rehab) → Hard money, bridge loan
- Foreign national → Non-QM foreign national program (no SSN required)
- ITIN borrower → FHA with ITIN (some lenders), Non-QM

PROPERTY TYPES:
- Primary residence: all programs eligible
- Second home: conventional only (10% down minimum), not FHA/VA/USDA
- Investment SFR (rental): DSCR, conventional (25% down)
- Investment 2-4 unit: DSCR, conventional (25% down for investment, 3.5% if owner-occupying one unit)
- Multifamily 5+: commercial loan, not residential guidelines
- Condo: standard programs but warrantable condo required for conventional/FHA
- Non-warrantable condo: Non-QM, portfolio loan

RESERVES REQUIREMENTS:
- Conventional: 2–6 months PITI
- Jumbo: 6–12 months PITI
- DSCR: 3–6 months PITI per property
- FHA: not required but helps with AUS

KEY CALCULATIONS:
- Monthly P&I: M = P * [r(1+r)^n] / [(1+r)^n - 1] where r = monthly rate, n = 360 (30yr) or 180 (15yr)
- PITIA = P&I + monthly property taxes + monthly homeowners insurance + monthly HOA/association dues
- Front-end DTI = PITIA / gross monthly income * 100
- Back-end DTI = (PITIA + all other monthly debts) / gross monthly income * 100
- DSCR = gross monthly rent / PITIA

PERIOD CONVERSION (always convert to monthly before calculating):
- If yearly: divide by 12
- If quarterly: divide by 3
- If monthly: use as-is
- Always confirm which period was provided before calculating

TAXES:
- Use the most current available tax amount the realtor provides
- If not provided, estimate: 1.0–1.2% of purchase price annually for FL (varies by county)
- Always ask if unknown — taxes significantly impact DTI
- Convert to monthly: annual tax / 12

INSURANCE:
- Homeowners insurance typically $100–$300/month for standard SFR in FL
- Flood insurance may be required in flood zones — ask if applicable
- Condo: master policy may cover exterior; ask about HO-6 policy
- Always ask if not provided

HOA / ASSOCIATION DUES:
- MANDATORY if property is in an HOA, condo association, or any community with dues
- Must ask: "Is the property in an HOA or association?" — this is required
- If yes: get the exact monthly amount (or yearly/quarterly to convert)
- HOA dues are fully included in PITIA and directly impact front-end DTI
- High HOA ($500+/month) can significantly reduce max qualifying loan amount
- Max purchase (conventional): work backwards from max DTI and income
`;

      const systemPrompt = `You are an expert mortgage prequalification assistant for Underlytix, helping real estate agents quickly assess their clients' financing eligibility. You are NOT a lender and you do NOT verify documents. The realtor provides data — you apply lending guidelines accurately.

LANGUAGE RULE (highest priority):
Detect the language of each incoming message and respond entirely in that same language.
If the conversation switches languages mid-session, switch your responses to match immediately.
All JSON field keys inside <PREQUAL_RESULT> must stay in English (loanType, result, maxLoanAmount, etc.) but all human-readable text values (summary, nextSteps, improvementStrategies actions/labels, etc.) must be written in the detected language.
Loan product names should follow their common name in the target language where one exists (e.g. "prêt conventionnel" in French, "préstamo convencional" in Spanish).
Financial calculations, US lending limits, and guidelines remain identical regardless of language.

${GUIDELINES}

YOUR JOB:
1. Gather client information through natural conversation. Ask one or two questions at a time — never a list.
2. Determine the right loan product based on the situation.
3. Run accurate calculations based on the guidelines above.
4. Produce a clear, honest prequalification assessment.

INFORMATION YOU NEED (gather naturally, in roughly this order):
- Purchase price and target loan amount (or down payment %)
- State and county (for loan limits and tax estimates)
- Property type and intended use (primary, investment, second home)
- Is the property in an HOA or condo/community association? (MANDATORY — always ask)
  - If yes: get the HOA/association dues amount AND confirm: monthly, yearly, or quarterly?
- Property taxes: ask for the most current tax amount AND confirm: monthly, yearly, or quarterly?
  - If unknown, note you'll estimate based on purchase price
- Homeowners insurance amount AND confirm: monthly, yearly, or quarterly?
  - If unknown, note you'll use a reasonable estimate
- Client's gross monthly or annual income
- Monthly debt obligations (car payments, student loans, credit cards minimum payments, etc.)
- Credit score (approximate range is fine)
- Employment type (W-2, self-employed, 1099, investor)

CONVERSATION STYLE:
- Talk to the realtor directly ("Your client..."), not to the client
- Be conversational and efficient — realtors are busy, but accuracy requires complete data
- Ask for taxes, insurance, and HOA in a single natural question when possible
- ALWAYS confirm whether amounts given are monthly, yearly, or quarterly — then convert to monthly automatically
- Show your math when converting: "You gave me $3,600/year in taxes — that's $300/month"
- When you have all PITIA components, calculate and show the full breakdown:
  P&I: $X | Taxes: $X/mo | Insurance: $X/mo | HOA: $X/mo | TOTAL PITIA: $X
- State the result plainly: "Based on what you've shared, your client likely qualifies for a [loan type] up to $[amount]"
- ALWAYS include this disclaimer verbatim at the end of every final result:
  "⚠️ This prequalification is based solely on the information provided and is not a commitment to lend. All loan approvals are subject to full lender underwriting, credit review, income verification, appraisal, and final lender decision."
- Flag risks honestly: high DTI, low credit, unusual employment, flood zone insurance, high HOA, etc.
- If HOA is very high (>$500/mo), explicitly note its impact on qualifying amount

WHEN CLIENT DOES NOT QUALIFY (result is "borderline" or "unlikely"):
You MUST provide specific, actionable improvement strategies based on the exact reason(s) for not qualifying.
Combine strategies when a single fix is insufficient. Always rank by ease of execution.

STRATEGY PLAYBOOK:

HIGH DTI:
- Co-borrower: Calculate exactly how much co-borrower income is needed to bring DTI within limit
- Debt payoff: Identify which specific debts to eliminate and the exact DTI impact
- Lower purchase price: Calculate the exact price point where DTI falls within range
- Increase down payment: Calculate the additional down payment needed and resulting DTI
- Combined: Model combinations — e.g. "Pay off auto loan + target $340k = qualifies"

LOW CREDIT SCORE:
- Rapid rescore: What specific items, if addressed, could add points within 30-45 days
- FHA threshold: At 580+ = 3.5% down; at 500-579 = 10% down; show the gap
- Utilization fix: "Paying revolving balances to 30% or less typically adds 20-40 points in one cycle"
- Product shift: At low scores, pivot to asset-based products (DSCR, hard money, Non-QM)

HIGH LTV / LOW DOWN PAYMENT:
- Minimum down needed: Calculate the exact dollar gap to reach required LTV
- Gift funds: Note FHA/conventional allow gift funds — quantify the gap
- DPA programs: Reference Florida Hometown Heroes, SHIP, or local programs
- Lower price point: Calculate purchase price where current down payment hits required LTV

EMPLOYMENT / INCOME ISSUES:
- Self-employed: Bank statement loans use 12-24 months deposits (typically 50% of gross)
- 1099: 2-year history → conventional; less → bank statement
- Variable income: Average of 2 years; show qualifying income calculation
- Thin file: Non-QM or portfolio lenders have more flexibility

COMBINED STRATEGY PATHS — always model multiple paths when not qualifying:
Format as: "Path 1: [action] = [outcome]. Path 2: [action] = [outcome]. Path 3: [combined actions] = [outcome]."
Rank by lowest cost/effort first.

PARTNER LENDER NETWORK — include on every result, qualifying or not:
"Working with lenders in the Underlytix network can help expedite your client's financing process.
Our partner lenders are already familiar with profiles like this and can move quickly.
Your client's anonymized details have been forwarded to our network for preliminary review."

When you have enough information to make a determination, respond with a JSON block at the end of your message in this exact format:
<PREQUAL_RESULT>
{
  "ready": true,
  "loanType": "conventional|fha|va|usda|jumbo|dscr|hard_money|bank_statement|non_qm",
  "result": "likely_qualifies|borderline|unlikely|needs_review",
  "maxLoanAmount": 0,
  "estimatedMonthlyPayment": 0,
  "monthlyPI": 0,
  "monthlyTaxes": 0,
  "monthlyInsurance": 0,
  "monthlyHOA": 0,
  "monthlyPITIA": 0,
  "frontEndDTI": 0,
  "backEndDTI": 0,
  "ltv": 0,
  "creditScoreAssessment": "strong|acceptable|borderline|insufficient",
  "summary": "2-3 sentence plain English summary",
  "recommendedProducts": ["product1", "product2"],
  "riskFlags": ["flag1", "flag2"],
  "improvementStrategies": [
    {
      "issue": "e.g. High DTI",
      "paths": [
        {"label": "Path 1", "action": "Pay off auto loan", "impact": "DTI drops from 52% to 44%"},
        {"label": "Path 2", "action": "Add co-borrower ($3k/month)", "impact": "DTI drops to 41%"},
        {"label": "Path 3 (combined)", "action": "Pay off auto loan + lower price to $340k", "impact": "Qualifies at current down payment"}
      ]
    }
  ],
  "qualifyingPricePoint": 0,
  "qualifyingDownPayment": 0,
  "coborrowerIncomeNeeded": 0,
  "creditScoreTarget": 0,
  "autoSubmitted": true,
  "nextSteps": "What the realtor should do next",
  "disclaimer": "This prequalification is based solely on the information provided and is not a commitment to lend. All loan approvals are subject to full lender underwriting, credit review, income verification, appraisal, and final lender decision."
}
</PREQUAL_RESULT>

Set autoSubmitted: true on every result — details are always forwarded to the lender network.
When result is "borderline" or "unlikely", you MUST include detailed remediation strategies.
For each barrier to qualification, provide 2-3 specific paths with exact numbers.

If you don't have enough information yet, set "ready": false and omit the other fields.`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1500,
          system: systemPrompt,
          messages: messages || [],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic error: ${err}`);
      }

      const data = await response.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");

      // Extract structured result if present
      let prequal = null;
      const match = text.match(/<PREQUAL_RESULT>([\s\S]*?)<\/PREQUAL_RESULT>/);
      if (match) {
        try { prequal = JSON.parse(match[1].trim()); } catch (e) { /* ignore */ }
      }

      // Clean message (remove the JSON block from display)
      const cleanText = text.replace(/<PREQUAL_RESULT>[\s\S]*?<\/PREQUAL_RESULT>/g, "").trim();

      return new Response(JSON.stringify({
        success: true,
        message: cleanText,
        prequal: prequal?.ready ? prequal : null,
      }), { status: 200, headers: cors });
    }

    // ── SAVE: persist completed prequal to Supabase ──────────────────────────
    if (action === "save") {
      if (!token) return new Response(JSON.stringify({ error: "Token required" }), { status: 401, headers: cors });

      const authRes = await fetch(REALTOR_AUTH_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", token }),
      });
      const authData = await authRes.json();
      if (!authData.valid) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

      const realtorId = authData.realtor.id;
      const p = clientData?.prequal || {};

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/client_prequals`, {
        method: "POST",
        headers: {
          "apikey": SVC_KEY,
          "Authorization": `Bearer ${SVC_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          realtor_id: realtorId,
          client_name: clientData?.clientName || "Client",
          client_email: clientData?.clientEmail || null,
          client_phone: clientData?.clientPhone || null,
          loan_type: p.loanType,
          property_type: clientData?.propertyType,
          purchase_price: clientData?.purchasePrice,
          loan_amount: p.maxLoanAmount,
          ltv: p.ltv,
          front_end_dti: p.frontEndDTI,
          back_end_dti: p.backEndDTI,
          credit_score: clientData?.creditScore,
          state: clientData?.state,
          prequal_result: p.result,
          max_loan_amount: p.maxLoanAmount,
          recommended_products: p.recommendedProducts,
          ai_summary: p.summary,
          risk_flags: p.riskFlags,
          raw_chat: clientData?.messages,
        }),
      });

      if (!insertRes.ok) {
        const e = await insertRes.json();
        throw new Error(e.message || "Failed to save prequal");
      }

      const saved = await insertRes.json();

      await fetch(REALTOR_AUTH_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "increment_usage", token }),
      });

      return new Response(JSON.stringify({ success: true, prequal: saved[0] }), { status: 200, headers: cors });
    }

    // ── HISTORY ───────────────────────────────────────────────────────────────
    if (action === "history") {
      if (!token) return new Response(JSON.stringify({ error: "Token required" }), { status: 401, headers: cors });
      const authRes = await fetch(REALTOR_AUTH_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", token }),
      });
      const authData = await authRes.json();
      if (!authData.valid) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

      const histRes = await fetch(
        `${SUPABASE_URL}/rest/v1/client_prequals?realtor_id=eq.${authData.realtor.id}&order=created_at.desc&limit=20`,
        { headers: { "apikey": SVC_KEY, "Authorization": `Bearer ${SVC_KEY}` } }
      );
      const history = await histRes.json();
      return new Response(JSON.stringify({ success: true, history }), { status: 200, headers: cors });
    }

    // ── DELETE (admin-gated) ───────────────────────────────────────────────────
    if (action === "delete") {
      if (!token) return new Response(JSON.stringify({ error: "Token required" }), { status: 401, headers: cors });
      const delId = body.id;
      if (!delId) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: cors });

      const authRes = await fetch(REALTOR_AUTH_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", token }),
      });
      const authData = await authRes.json();
      if (!authData.valid) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

      // Two distinct authorities (kept separate for the audit trail):
      //  - platform admin (Underlytix) may delete any prequal
      //  - otherwise the row must belong to the calling realtor (single-seat = own admin)
      const PLATFORM_ADMINS = ["hpierre00@gmail.com"];
      const email = (authData.realtor.email || "").toLowerCase().trim();
      const role = authData.realtor.seat_role || authData.realtor.role || null;
      const isPlatformAdmin = PLATFORM_ADMINS.includes(email);
      const isOrgAdmin = role === "org_admin" || role === "admin";

      let delUrl = `${SUPABASE_URL}/rest/v1/client_prequals?id=eq.${encodeURIComponent(delId)}`;
      if (!isPlatformAdmin && !isOrgAdmin) {
        delUrl += `&realtor_id=eq.${authData.realtor.id}`;
      }

      const delRes = await fetch(delUrl, {
        method: "DELETE",
        headers: {
          "apikey": SVC_KEY,
          "Authorization": `Bearer ${SVC_KEY}`,
          "Prefer": "return=representation",
        },
      });
      if (!delRes.ok) {
        const e = await delRes.json().catch(() => ({}));
        return new Response(JSON.stringify({ success: false, error: e.message || "Delete failed" }), { status: 500, headers: cors });
      }
      const deleted = await delRes.json().catch(() => []);
      if (!deleted || !deleted.length) {
        return new Response(JSON.stringify({ success: false, error: "Not found or not permitted" }), { status: 403, headers: cors });
      }
      return new Response(JSON.stringify({ success: true, deleted: deleted.length, by: isPlatformAdmin ? "platform_admin" : "owner" }), { status: 200, headers: cors });
    }

    // ── CHECKOUT ──────────────────────────────────────────────────────────────
    if (action === "create_checkout") {
      if (!token) return new Response(JSON.stringify({ error: "Token required" }), { status: 401, headers: cors });
      const authRes = await fetch(REALTOR_AUTH_FN, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", token }),
      });
      const authData = await authRes.json();
      if (!authData.valid) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });
      const realtor = authData.realtor;

      if (!STRIPE_SECRET) {
        const REALTOR_PAYMENT_URL = `https://buy.stripe.com/00w28t2TjgKW9e2bZtb7y06?prefilled_email=${encodeURIComponent(authData.realtor?.email||"")}&client_reference_id=${authData.realtor?.id||""}`;
        return new Response(JSON.stringify({ success: true, checkoutUrl: REALTOR_PAYMENT_URL }), { status: 200, headers: cors });
      }

      const userRes = await fetch(`${SUPABASE_URL}/rest/v1/realtor_users?id=eq.${realtor.id}&select=stripe_customer_id`, {
        headers: { "apikey": SVC_KEY, "Authorization": `Bearer ${SVC_KEY}` }
      });
      const userRows = await userRes.json();
      let cid = userRows[0]?.stripe_customer_id;

      if (!cid) {
        const cr = await fetch("https://api.stripe.com/v1/customers", {
          method: "POST",
          headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ email: realtor.email, name: realtor.name || "", "metadata[realtor_id]": realtor.id }),
        });
        const c = await cr.json();
        if (!cr.ok) throw new Error(c.error?.message || "Failed to create Stripe customer");
        cid = c.id;
        await fetch(`${SUPABASE_URL}/rest/v1/realtor_users?id=eq.${realtor.id}`, {
          method: "PATCH",
          headers: { "apikey": SVC_KEY, "Authorization": `Bearer ${SVC_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ stripe_customer_id: cid }),
        });
      }

      const sr = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          mode: "subscription", customer: cid,
          "line_items[0][price]": REALTOR_PRICE_ID, "line_items[0][quantity]": "1",
          success_url: successUrl || "https://underlytix.com/?realtor_upgraded=true",
          cancel_url: cancelUrl || "https://underlytix.com/",
          "subscription_data[metadata][realtor_id]": realtor.id,
          allow_promotion_codes: "true",
        }),
      });
      const s = await sr.json();
      if (!sr.ok) throw new Error(s.error?.message || "Checkout session failed");
      return new Response(JSON.stringify({ success: true, checkoutUrl: s.url }), { status: 200, headers: cors });
    }

    // ── PORTAL ────────────────────────────────────────────────────────────────
    if (action === "create_portal") {
      if (!token) return new Response(JSON.stringify({ error: "Token required" }), { status: 401, headers: cors });
      const authRes = await fetch(REALTOR_AUTH_FN, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", token }),
      });
      const authData = await authRes.json();
      if (!authData.valid) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

      const userRes = await fetch(`${SUPABASE_URL}/rest/v1/realtor_users?id=eq.${authData.realtor.id}&select=stripe_customer_id`, {
        headers: { "apikey": SVC_KEY, "Authorization": `Bearer ${SVC_KEY}` }
      });
      const userRows = await userRes.json();
      const cid = userRows[0]?.stripe_customer_id;
      if (!cid) return new Response(JSON.stringify({ error: "No active subscription found" }), { status: 400, headers: cors });
      if (!STRIPE_SECRET) return new Response(JSON.stringify({ error: "Billing portal unavailable" }), { status: 500, headers: cors });

      const pr = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ customer: cid, return_url: "https://underlytix.com/" }),
      });
      const po = await pr.json();
      if (!pr.ok) throw new Error(po.error?.message || "Portal session failed");
      return new Response(JSON.stringify({ success: true, portalUrl: po.url }), { status: 200, headers: cors });
    }

    // ── CAPITAL MATCH REQUEST ─────────────────────────────────────────────────
    if (action === "request_capital_match") {
      if (!token) return new Response(JSON.stringify({ error: "Token required" }), { status: 401, headers: cors });
      const authRes = await fetch(REALTOR_AUTH_FN, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", token }),
      });
      const authData = await authRes.json();
      if (!authData.valid) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

      const p = body.prequal || {};
      const clientName = body.clientName || "Client";
      const clientEmail = body.clientEmail || "";
      const clientPhone = body.clientPhone || "";
      const SUPABASE_URL_L = "https://mxyepucitjzleaziizkr.supabase.co";
      const SK_LOCAL = Netlify.env.get("SUPABASE_SERVICE_KEY") || "";

      if (SK_LOCAL) {
        const loanType = p.loanType || "";
        const qmTypes = ["conventional", "fha", "va", "usda", "jumbo"];
        const dealCode = "RM-" + Date.now().toString(36).toUpperCase();
        await fetch(`${SUPABASE_URL_L}/rest/v1/deal_submissions`, {
          method: "POST",
          headers: { "apikey": SK_LOCAL, "Authorization": `Bearer ${SK_LOCAL}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
          body: JSON.stringify({
            deal_code: dealCode,
            deal_type: "realtor_match",
            asset_type: "residential",
            state: p.state || null,
            requested_loan_amount: p.maxLoanAmount || null,
            requested_ltv: p.ltv || null,
            deal_category: qmTypes.includes(loanType) ? "qm" : "non_qm",
            investor_name: clientName,
            investor_email: clientEmail,
            ai_analysis: {
              source: "realtor_portal",
              realtor_email: authData.realtor?.email || null,
              client_phone: clientPhone,
              loan_type: loanType,
              prequal_result: p.result,
              max_loan_amount: p.maxLoanAmount,
              monthly_pitia: p.monthlyPITIA,
              back_end_dti: p.backEndDTI,
              front_end_dti: p.frontEndDTI,
              risk_flags: p.riskFlags || [],
              summary: p.summary || "",
            },
          }),
        }).catch(() => {});

        if (body.prequal_id) {
          await fetch(`${SUPABASE_URL_L}/rest/v1/client_prequals?id=eq.${body.prequal_id}`, {
            method: "PATCH",
            headers: { "apikey": SK_LOCAL, "Authorization": `Bearer ${SK_LOCAL}`, "Content-Type": "application/json" },
            body: JSON.stringify({ match_requested: true, match_requested_at: new Date().toISOString() }),
          }).catch(() => {});
        }
      }

      let lenderEmails = [];
      if (SK_LOCAL) {
        const lRes = await fetch(`${SUPABASE_URL_L}/rest/v1/lender_users?select=email&limit=50`, {
          headers: { "apikey": SK_LOCAL, "Authorization": `Bearer ${SK_LOCAL}` }
        }).catch(() => null);
        if (lRes?.ok) {
          const lenders = await lRes.json().catch(() => []);
          lenderEmails = lenders.map(l => l.email).filter(Boolean);
        }
      }

      const emailHtml = `<div style="font-family:sans-serif;padding:20px;max-width:600px">
        <div style="background:#0f172a;padding:20px;border-radius:8px;margin-bottom:20px">
          <h2 style="color:white;margin:0;font-size:18px">🔗 New Client Match Request</h2>
          <p style="color:rgba(255,255,255,0.5);margin:4px 0 0;font-size:12px">Underlytix Lender Network</p>
        </div>
        <p style="color:#374151;font-size:13px;line-height:1.6">A realtor on the Underlytix platform has submitted a client scenario for preliminary lender review.</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0">
          <tr style="background:#f9fafb"><td style="padding:8px 12px;color:#6b7280;width:140px">Loan Type</td><td style="padding:8px 12px;font-weight:600">${p.loanType || "—"}</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280">Prequal Result</td><td style="padding:8px 12px;font-weight:600;color:${p.result === 'likely_qualifies' ? '#059669' : p.result === 'borderline' ? '#d97706' : '#dc2626'}">${p.result === 'likely_qualifies' ? '✓ Strong Alignment' : p.result === 'borderline' ? '⚠ Needs Review' : p.result || '—'}</td></tr>
          <tr style="background:#f9fafb"><td style="padding:8px 12px;color:#6b7280">Max Loan</td><td style="padding:8px 12px;font-weight:600">$${(p.maxLoanAmount || 0).toLocaleString()}</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280">PITIA</td><td style="padding:8px 12px">$${(p.monthlyPITIA || 0).toLocaleString()}/mo</td></tr>
          <tr style="background:#f9fafb"><td style="padding:8px 12px;color:#6b7280">Back-end DTI</td><td style="padding:8px 12px">${p.backEndDTI || "—"}%</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280">Risk Flags</td><td style="padding:8px 12px;color:#dc2626">${(p.riskFlags || []).join(", ") || "None"}</td></tr>
          <tr style="background:#f9fafb"><td style="padding:8px 12px;color:#6b7280">Client</td><td style="padding:8px 12px">${clientName}${clientEmail ? ` · ${clientEmail}` : ""}${clientPhone ? ` · ${clientPhone}` : ""}</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280">Realtor</td><td style="padding:8px 12px">${authData.realtor?.email || "—"}</td></tr>
        </table>
        <p style="font-size:13px;color:#374151;line-height:1.6"><strong>Summary:</strong> ${p.summary || "—"}</p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px;margin-top:16px;font-size:12px;color:#166534">
          To respond to this inquiry, reply directly to the realtor at <strong>${authData.realtor?.email || "—"}</strong>
        </div>
        <p style="font-size:11px;color:#9ca3af;margin-top:16px">This is a preliminary review request only. No commitment to lend is implied.</p>
      </div>`;

      const RESEND_KEY = Netlify.env.get("RESEND_API_KEY") || "";
      if (RESEND_KEY) {
        const allRecipients = [...new Set(["heroldpierre@sofloam.com", ...lenderEmails])];
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Underlytix <noreply@underlytix.com>",
            to: allRecipients,
            reply_to: authData.realtor?.email || "noreply@underlytix.com",
            subject: `New Client Match — ${p.loanType?.toUpperCase() || "Loan"} · $${(p.maxLoanAmount || 0).toLocaleString()} · ${p.result === 'likely_qualifies' ? 'Strong Alignment' : p.result === 'borderline' ? 'Needs Review' : p.result || '—'}`,
            html: emailHtml,
          }),
        }).catch(() => {});
      }

      return new Response(JSON.stringify({ success: true }), { status: 200, headers: cors });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: cors });

  } catch (e) {
    console.error("realtor-prequal error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/realtor-prequal" };
