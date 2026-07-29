// Build marker: bump on every deploy so we can confirm which code is live.
const BUILD = "2026-07-29-selftest";
const MODEL_FAST = "claude-haiku-4-5-20251001";
const MODEL_MAIN = "claude-sonnet-5";

export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });

  // ── DIAGNOSTICS (GET) ──────────────────────────────────────────────────────
  // GET  /.netlify/functions/capiq-analyze            -> which build is live + env presence
  // GET  /.netlify/functions/capiq-analyze?selftest=1 -> live Anthropic call per model
  // Never returns secret values, only booleans and upstream status text.
  if (req.method === "GET") {
    const key = Netlify.env.get("ANTHROPIC_API_KEY");
    const info = {
      build: BUILD,
      models: { fast: MODEL_FAST, main: MODEL_MAIN },
      env: {
        ANTHROPIC_API_KEY: !!key,
        RENTCAST_API_KEY: !!Netlify.env.get("RENTCAST_API_KEY"),
        SUPABASE_SERVICE_KEY: !!Netlify.env.get("SUPABASE_SERVICE_KEY"),
      },
    };
    const wantsSelftest = new URL(req.url).searchParams.get("selftest");
    if (!wantsSelftest) return new Response(JSON.stringify(info, null, 2), { status: 200, headers: cors });

    if (!key) {
      info.selftest = { error: "ANTHROPIC_API_KEY is not set; cannot test models." };
      return new Response(JSON.stringify(info, null, 2), { status: 200, headers: cors });
    }
    info.selftest = {};
    for (const [label, model] of [["fast", MODEL_FAST], ["main", MODEL_MAIN]]) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
        });
        const txt = await r.text();
        info.selftest[label] = { model, status: r.status, ok: r.ok, body: txt.slice(0, 400) };
      } catch (e) {
        info.selftest[label] = { model, error: String((e && e.message) || e) };
      }
    }
    return new Response(JSON.stringify(info, null, 2), { status: 200, headers: cors });
  }

  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed", build: BUILD }), { status: 405, headers: cors });

  try {
    const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured", build: BUILD }), { status: 200, headers: cors });

    const body = await req.json();

    // ── LISTING AUTO-FILL ────────────────────────────────────────────────────
    if (body.action === 'fetch-listing') {
      const { url, address } = body;
      var propertyRef = address || '';
      if (url && !propertyRef) {
        try {
          var zM = url.match(/zillow\.com\/homedetails\/([^/?]+)/);
          if (zM) propertyRef = decodeURIComponent(zM[1]).replace(/-?\d{6,}_zpid$/, '').replace(/-/g, ' ').trim();
          var rM = url.match(/realtor\.com\/realestateandhomes-detail\/([^/?]+)/);
          if (rM) propertyRef = decodeURIComponent(rM[1]).replace(/_M\d+.*$/, '').replace(/_/g, ' ').trim();
          var rfM = url.match(/redfin\.com\/[A-Z]{2}\/([^/]+)\/([^/]+)\/home/);
          if (rfM) propertyRef = decodeURIComponent(rfM[2]).replace(/-/g, ' ').trim() + ' ' + decodeURIComponent(rfM[1]).replace(/-/g, ' ');
          if (!propertyRef) propertyRef = url;
        } catch(e) { propertyRef = url; }
      }
      if (!propertyRef) return new Response(JSON.stringify({ error: 'Please provide an address.' }), { status: 400, headers: cors });

      var schema = '{"address":"formatted full address","city":"City","state":"ST","zip":"12345","proptype":"sfr","beds":3,"baths":2,"sqft":1650,"yearbuilt":2005}';
      var listingPrompt = 'Parse this property reference: ' + propertyRef + '. Return ONLY a valid JSON object, no markdown, no code fences. Use this structure: ' + schema + ' Rules: proptype must be sfr, 24unit, mf5, or condo. beds/baths/sqft/yearbuilt return null if unknown. Do NOT include price, rent, taxes, or HOA.';
      try {
        const lRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: MODEL_FAST, max_tokens: 200, messages: [{ role: 'user', content: listingPrompt }] }),
        });
        if (!lRes.ok) {
          var errTxt = await lRes.text();
          return new Response(JSON.stringify({
            success: false, build: BUILD,
            error: 'Address lookup failed (' + lRes.status + ' from model ' + MODEL_FAST + '). ' + errTxt.slice(0, 300)
          }), { status: 200, headers: cors });
        }
        var lData = await lRes.json();
        // NOTE: these are prefixed to avoid colliding with `raw`/`cleaned` in the
        // analysis path below. `var` is function-scoped, so reusing those names here
        // is a SyntaxError that makes the whole function fail to parse (502 at runtime).
        var lRaw = ((lData.content||[]).find(b=>b.type==='text')||{}).text || '';
        var lCleaned = lRaw.trim().replace(/```[\w]*/g,'').replace(/```/g,'').trim();
        var listing = { address: propertyRef, proptype: 'sfr' };
        try { var lp = JSON.parse(lCleaned); if (lp && lp.address) listing = lp; } catch(e) {
          var lMatch = lCleaned.match(/\{[\s\S]*\}/); if (lMatch) { try { var lp2 = JSON.parse(lMatch[0]); if (lp2&&lp2.address) listing = lp2; } catch(e2){} }
        }
        listing.needsManual = ['price','rent','taxes','hoa','insurance'];
        listing.guidance = { price:'Enter from listing page',rent:'Find on Rentometer.com or Zillow Rent Estimate',taxes:'Find on county property appraiser',hoa:'Check listing details',insurance:'Estimate 0.75–1% of price annually' };
        return new Response(JSON.stringify({ success: true, listing }), { status: 200, headers: cors });
      } catch(e) {
        return new Response(JSON.stringify({ success: true, listing: { address: propertyRef, proptype: 'sfr', needsManual: ['price','rent','taxes','hoa','insurance'] } }), { status: 200, headers: cors });
      }
    }

    const d = body.dealData || body;

    const prompt = body.prompt || `You are an expert real estate underwriter for Underlytix. Analyze this deal and return ONLY a JSON object with no markdown.

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
      body: JSON.stringify({ model: MODEL_MAIN, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({
        build: BUILD,
        error: "Analysis failed (" + res.status + " from model " + MODEL_MAIN + ")",
        detail: err.slice(0, 500),
      }), { status: 200, headers: cors });
    }

    const data = await res.json();
    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    let analysis;
    try {
      analysis = JSON.parse(cleaned);
    } catch (parseErr) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { analysis = JSON.parse(m[0]); } catch (e2) { analysis = null; } }
    }
    if (!analysis) {
      return new Response(JSON.stringify({
        build: BUILD,
        error: "The analysis model returned a response that could not be read as JSON.",
        detail: cleaned.slice(0, 400),
      }), { status: 200, headers: cors });
    }

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
    return new Response(JSON.stringify({
      build: BUILD,
      error: "Server error: " + String((err && err.message) || err),
    }), { status: 200, headers: cors });
  }
};
