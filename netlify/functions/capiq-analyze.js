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
    const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), { status: 500, headers: cors });

    const body = await req.json();
    const d = body.dealData || body;

    const prompt = `You are an expert real estate underwriter for Underlytix. Analyze this deal and return ONLY a JSON object with no markdown.

Deal: ${d.dealType} | ${d.propertyType} | ${d.state} | ${d.location}
Loan: $${d.loanAmount} | Purchase: $${d.purchasePrice} | ARV: $${d.arv}
As-Is Value: $${d.asIsValue} | Rehab: $${d.rehabBudget} | Rent: $${d.monthlyRent}/mo
LTV: ${d.ltv}% | DSCR: ${d.dscr} | Credit: ${d.creditScore} | Exp: ${d.investorExperience}
Notes: ${d.notes || "None"}

Return exactly this JSON:
{"fundabilityScore":0,"dealScore":"Pass","humanReviewRequired":false,"executiveSummary":"","strengthsAndRisks":"","lenderMatchingProfile":"","structuringRecommendations":"","marketContext":"","scoreBreakdown":"","nextSteps":""}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: "Anthropic error", detail: err }), { status: 502, headers: cors });
    }

    const data = await res.json();
    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const analysis = JSON.parse(cleaned);

    // Fire analysis_complete email in background (non-blocking)
    if (d.investorEmail && d.dealCode) {
      const baseUrl = Netlify.env.get("SITE_URL") || "https://underlytix.com";
      fetch(`${baseUrl}/.netlify/functions/resend-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "analysis_complete",
          to: d.investorEmail,
          name: d.investorName || "",
          data: {
            fundabilityScore: analysis.fundabilityScore,
            scoreBand: analysis.dealScore,
            executiveSummary: analysis.executiveSummary,
            dealCode: d.dealCode,
          },
        }),
      }).catch(() => {}); // fire and forget
    }

    // Fire Notion sync in background (non-blocking)
    const baseUrl = Netlify.env.get("SITE_URL") || "https://underlytix.com";
    fetch(`${baseUrl}/.netlify/functions/notion-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealData: d, analysis }),
    }).catch(() => {});

    // Save deal to Supabase + create lender_matches (non-blocking)
    const SVC_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
    const SUPABASE_URL = "https://mxyepucitjzleaziizkr.supabase.co";
    if (SVC_KEY) {
      (async () => {
        try {
          const qmDealTypes = ['conventional','fha','va','usda','jumbo'];
          const dealCategory = qmDealTypes.includes((d.dealType||'').toLowerCase()) ? 'qm' : 'non_qm';

          const dealInsert = await fetch(`${SUPABASE_URL}/rest/v1/deal_submissions`, {
            method: 'POST',
            headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
            body: JSON.stringify({
              deal_type: d.dealType, asset_type: d.propertyType, state: d.state,
              city: d.location, purchase_price: parseFloat(d.purchasePrice)||null,
              current_value: parseFloat(d.asIsValue)||null, arv: parseFloat(d.arv)||null,
              requested_loan_amount: parseFloat(d.loanAmount)||null,
              requested_ltv: parseFloat(d.ltv)||null, dscr: parseFloat(d.dscr)||null,
              monthly_rent: parseFloat(d.monthlyRent)||null, rehab_budget: parseFloat(d.rehabBudget)||null,
              exit_strategy: d.exitStrategy, deal_category: dealCategory,
              investor_id: d.investorId||null, investor_name: d.investorName||null, investor_email: d.investorEmail||null,
              ai_analysis: analysis,
            }),
          });
          if (!dealInsert.ok) return;
          const [savedDeal] = await dealInsert.json();
          if (!savedDeal?.id) return;

          // Find matching lenders based on qm_category and basic criteria
          const lendersRes = await fetch(
            `${SUPABASE_URL}/rest/v1/lender_users?select=id,qm_category&or=(qm_category.eq.${dealCategory},qm_category.eq.both)&limit=50`,
            { headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}` } }
          );
          const lenders = lendersRes.ok ? await lendersRes.json() : [];

          if (lenders.length) {
            const matchRows = lenders.map(l => ({
              deal_id: savedDeal.id, lender_id: l.id,
              match_status: 'pending', interest_level: 'pending',
              match_score: analysis.fundabilityScore || 0,
              deal_score_val: analysis.fundabilityScore || 0,
              routed_at: new Date().toISOString(),
            }));
            await fetch(`${SUPABASE_URL}/rest/v1/lender_matches`, {
              method: 'POST',
              headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(matchRows),
            }).catch(() => {});
          }
        } catch(e) { console.warn('deal save error:', e.message); }
      })();
    }

    return new Response(JSON.stringify({ success: true, analysis }), { status: 200, headers: cors });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Server error", message: err.message }), { status: 500, headers: cors });
  }
};
