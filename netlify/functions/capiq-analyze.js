// Build marker: bump on every deploy so we can confirm which code is live.
const BUILD = "2026-07-31-model-timing-4way";
const MODEL_FAST = "claude-haiku-4-5-20251001";
const MODEL_MAIN = "claude-sonnet-5";
// Diagnostic-only, for ?selftest=timing&model=opus|fable -- not used in the production
// analysis path (that's always MODEL_MAIN), only here to compare timing/quality before
// deciding on a fix for the 10s-timeout-vs-response-quality tradeoff documented above.
const MODEL_OPUS = "claude-opus-5";
const MODEL_FABLE = "claude-fable-5";

// `context` (second param) is required for context.waitUntil() below. The prior
// version of this fix awaited the deal-save/email/Notion tasks directly before
// returning, which was correct for durability but added their combined latency
// (three real network calls, one of them multiple round trips to Supabase) on
// top of the Anthropic call that had already run — enough to trip Netlify's
// function timeout and return a 504 to the client on a deal that had, in fact,
// already been fully analyzed. waitUntil sends the response the moment the
// analysis is ready and keeps the invocation alive in the background only for
// the side-effect writes, which is what it's for.
export default async (req, context) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    // Without this the CDN caches GET responses, so the diagnostics below return
    // stale results and read as "still broken" after a fix has already landed.
    "Cache-Control": "no-store, max-age=0",
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

    // ?selftest=analysis — run the real analysis shape end to end and report whether
    // the output parses. Answers "is it truncating or is it malformed?" definitively,
    // without needing the UI or devtools.
    if (wantsSelftest === "analysis") {
      const samplePrompt = `You are an expert real estate underwriter for Underlytix. Analyze this deal and return ONLY valid JSON, no markdown.

Deal: Fix & Flip | SFR | FL | 5221 Hawkes Bluff Ave, Davie FL 33331
Loan: $450000 | Purchase: $600000 | ARV: $850000
As-Is Value: $600000 | Rehab: $120000 | Rent: $0/mo
LTV: 75% | DSCR: 0 | Credit: 720 | Exp: 10-20 Deals
Notes: None

Return this exact JSON with all string fields filled with detailed analysis (2-4 sentences each):
{"fundabilityScore":0,"dealScore":"Pass","humanReviewRequired":false,"executiveSummary":"","strengthsAndRisks":"","lenderMatchingProfile":"","structuringRecommendations":"","marketContext":"","scoreBreakdown":"","nextSteps":""}`;

      const out = {};
      for (const maxTokens of [2000, 8000]) {
        try {
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: MODEL_MAIN, max_tokens: maxTokens, messages: [{ role: "user", content: samplePrompt }] }),
          });
          if (!r.ok) { out["max_tokens_" + maxTokens] = { status: r.status, body: (await r.text()).slice(0, 300) }; continue; }
          const j = await r.json();
          const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
          const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          let parses = false;
          try { JSON.parse(clean); parses = true; } catch (e) { /* reported below */ }
          out["max_tokens_" + maxTokens] = {
            stop_reason: j.stop_reason,
            output_tokens: j.usage && j.usage.output_tokens,
            chars: clean.length,
            parses,
            endsWithBrace: clean.slice(-1) === "}",
            head: clean.slice(0, 120),
            tail: clean.slice(-120),
          };
        } catch (e) {
          out["max_tokens_" + maxTokens] = { error: String((e && e.message) || e) };
        }
      }
      info.analysisSelftest = out;
      return new Response(JSON.stringify(info, null, 2), { status: 200, headers: cors });
    }

    // ?selftest=timing — ONE real analysis call at the production max_tokens ceiling,
    // timed server-side. selftest=analysis (above) runs two sequential calls (2000
    // and 8000 max_tokens) and is itself slow enough to time out, which makes it
    // useless for answering the specific question "does the single production call
    // fit inside Netlify's function timeout?" This does exactly that, once.
    if (wantsSelftest === "timing") {
      // "Notes: None" was the best case, not a realistic one -- it's the least likely
      // to make the model ramble, so it never would have caught the truncation a real
      // user hit on a deal with an actual notes field. This mirrors app.html's
      // buildPrompt() shape (that's the prompt real traffic sends, not the default
      // below) plus a verbose, realistic notes field, to actually exercise the
      // condition that broke in production instead of the easiest possible input.
      const samplePrompt = `You are an expert real estate underwriter for Underlytix. Analyze this deal and return ONLY valid JSON, no markdown.

DEAL: Fix & Flip | SFR | FL | 5221 Hawkes Bluff Ave, Davie FL 33331
LOAN: $450000 | PURCHASE: $600000 | ARV: $850000 | AS-IS: $600000
REHAB: $120000 | RENT: $0/mo | PAYMENT: $3200/mo
LTV: 75% | DSCR: N/A | CREDIT: 720 | EXP: 10-20 Deals
NOTES: Seller is motivated, needs to close within 30 days due to relocation for a new job. Property has an older roof (approx 15 years) and the HVAC was replaced in 2023. Borrower has two other active fix-and-flip projects in the same county and is coordinating contractors across all three. Considering either a full gut renovation or a lighter cosmetic rehab depending on comps that come back over the next two weeks; wants the analysis to account for both scenarios and note which is more likely to hit the stated ARV.

Return this exact JSON. Each string field must be ONE concise sentence, 25 words or fewer -- be direct, no hedging, no restating the numbers above. Your entire response, all fields combined, must total under 200 words. No markdown, no commentary outside the JSON:
{"fundabilityScore":0,"dealScore":"Pass","humanReviewRequired":false,"executiveSummary":"","strengthsAndRisks":"","lenderMatchingProfile":"","structuringRecommendations":"","marketContext":"","scoreBreakdown":"","nextSteps":""}`;
      // &model=fast runs MODEL_FAST instead of MODEL_MAIN, same prompt, same ceiling.
      // Added after ?selftest=compare (below) turned out useless: running both models
      // concurrently in one invocation via Promise.all *also* timed out three times in
      // a row, meaning two concurrent outbound Anthropic calls from a single Netlify
      // function don't get real wall-clock parallelism here -- so comparing solo
      // numbers from two separate invocations is the only way to get real data.
      const modelParam = new URL(req.url).searchParams.get("model");
      const useModel = modelParam === "fast" ? MODEL_FAST
        : modelParam === "opus" ? MODEL_OPUS
        : modelParam === "fable" ? MODEL_FABLE
        : MODEL_MAIN;
      const startedAt = Date.now();
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: useModel, max_tokens: 2500, messages: [{ role: "user", content: samplePrompt }] }),
        });
        const duration_ms = Date.now() - startedAt;
        if (!r.ok) {
          info.timingSelftest = { model: useModel, duration_ms, status: r.status, body: (await r.text()).slice(0, 300) };
        } else {
          const j = await r.json();
          const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
          const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          let analysis = null;
          try { analysis = JSON.parse(clean); } catch (e) { /* leave null */ }
          info.timingSelftest = {
            model: useModel, duration_ms, status: r.status, stop_reason: j.stop_reason,
            output_tokens: j.usage && j.usage.output_tokens, chars: clean.length, parses: !!analysis,
            analysis, raw: analysis ? undefined : clean.slice(0, 500),
          };
        }
      } catch (e) {
        info.timingSelftest = { model: useModel, duration_ms: Date.now() - startedAt, error: String((e && e.message) || e) };
      }
      return new Response(JSON.stringify(info, null, 2), { status: 200, headers: cors });
    }

    // ?selftest=compare used to run MODEL_MAIN and MODEL_FAST concurrently via
    // Promise.all in one invocation, to get a side-by-side timing/quality read in a
    // single call. Removed: it timed out three times in a row in production testing
    // here, meaning two concurrent outbound Anthropic calls from one Netlify function
    // don't get real wall-clock parallelism on this runtime -- Promise.all doesn't
    // buy headroom against a per-invocation timeout the way it would for two
    // independent, unrelated background tasks (compare context.waitUntil() usage
    // elsewhere in this file, which is a different situation: those run AFTER the
    // response is already sent). Use ?selftest=timing and ?selftest=timing&model=fast
    // as two separate calls instead -- slower to run by hand, but each one actually
    // completes and reports real numbers instead of both racing the same 10s clock.

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

Return exactly this JSON. Each string field must be ONE concise sentence, 25 words or fewer — be direct, no hedging, no restating the numbers above. Your entire response, all fields combined, must total under 200 words. No markdown, no commentary outside the JSON:
{"fundabilityScore":0,"dealScore":"Pass","humanReviewRequired":false,"executiveSummary":"","strengthsAndRisks":"","lenderMatchingProfile":"","structuringRecommendations":"","marketContext":"","scoreBreakdown":"","nextSteps":""}`;
    // NOTE: this default prompt only fires when the request omits `prompt` entirely.
    // app.html always sends an explicit `prompt` (buildPrompt()/buildCommercialPrompt()),
    // which overrides this — so for real traffic through the investor app, THIS prompt
    // is dead code. It's kept in sync with app.html's version anyway, for any other
    // caller that hits this endpoint without building its own prompt.

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      // History on this ceiling, because it's been wrong in both directions:
      //   2000, loose prompt ("2-4 sentences each")  -> real output ran past 2000
      //   tokens on verbose deals, truncated mid-object, JSON never closed.
      //   8000, same loose prompt -> stopped truncating, but this fetch is the ONLY
      //   awaited call on the response's critical path (side effects are on
      //   context.waitUntil(), see below), and a full ~4000-6000 token generation at
      //   this ceiling routinely ran past Netlify's function timeout (10s on this
      //   plan; 26s requires a support-activated flag, not just a config value) --
      //   the client saw a 504 for a deal that, server-side, actually finished.
      // Fix is the prompt above (hard word cap per field) plus this lower ceiling:
      // a 25-word-per-field cap keeps real output in the ~400-700 token range, well
      // under 2500, so generation finishes in a few seconds instead of 20-30+.
      // Verify with GET /.netlify/functions/capiq-analyze?selftest=timing — it
      // reports duration_ms, stop_reason and output_tokens for one real call at
      // this exact ceiling before trusting this comment.
      body: JSON.stringify({ model: MODEL_MAIN, max_tokens: 2500, messages: [{ role: "user", content: prompt }] }),
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
      // Include the shape of the failure, not just that it failed. stop_reason
      // "max_tokens" means truncation; anything else means malformed output.
      const truncated = data.stop_reason === "max_tokens";
      return new Response(JSON.stringify({
        build: BUILD,
        error: truncated
          ? "The analysis was cut off before it finished (hit the output limit). Try again; if it repeats, the token ceiling needs raising."
          : "The analysis model returned a response that could not be read as JSON.",
        diagnostics: {
          stop_reason: data.stop_reason,
          output_tokens: data.usage && data.usage.output_tokens,
          chars: cleaned.length,
          endsWithBrace: cleaned.slice(-1) === "}",
        },
        detail: cleaned.slice(0, 300),
        tail: cleaned.slice(-200),
      }), { status: 200, headers: cors });
    }

    // Email, Notion sync, and the Supabase save are built as promises here and
    // handed to context.waitUntil() below rather than awaited inline.
    //
    // History, in order:
    // 1. Originally unawaited fire-and-forget with no `context` param at all, so
    //    nothing guaranteed they ran to completion once the Response was sent. This
    //    was silent and total: a direct query against Supabase showed zero
    //    deal_submissions rows from any real app-driven analysis (across many
    //    submissions made while debugging this exact function), while rows inserted
    //    directly via seed data were unaffected.
    // 2. Fixed by awaiting them directly before returning. That guaranteed
    //    completion but added their combined latency (three real network calls,
    //    Supabase alone being two round trips) on top of the Anthropic call that
    //    had already run — long enough to trip Netlify's function timeout and
    //    return a 504 on a deal that had, in fact, already been fully analyzed.
    // 3. Current: `context` was added as the function's second parameter (see the
    //    signature above) so context.waitUntil() is available. The response goes
    //    out the moment the analysis is ready; Netlify keeps the invocation alive
    //    in the background only for these three writes.
    //
    // Each task already swallows its own errors internally, so a failed side
    // effect can never surface as a failed analysis response.
    const baseUrl = Netlify.env.get("SITE_URL") || "https://underlytix.com";

    const emailTask = (d.investorEmail && d.dealCode)
      ? fetch(`${baseUrl}/.netlify/functions/resend-email`, {
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
        }).catch(() => {})
      : Promise.resolve();

    const notionTask = fetch(`${baseUrl}/.netlify/functions/notion-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealData: d, analysis }),
    }).catch(() => {});

    // Save deal to Supabase + create lender_matches
    const SVC_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
    const SUPABASE_URL = "https://mxyepucitjzleaziizkr.supabase.co";
    const supabaseTask = SVC_KEY ? (async () => {
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

          // Find matching lenders based on qm_category and basic criteria.
          //
          // lender_matches.lender_id must be lender_users.lender_profile_id, NOT
          // lender_users.id. capiq-lender-portal-v4's get_deals action (the query that
          // backs the lender dashboard) filters lender_matches by the JWT's
          // lender_profile_id — a column it reads directly off the lender_users row at
          // login (`u.lender_profile_id`, distinct from `u.id`; login also embeds a
          // separate lender_profiles table via `.select('*,lender_profiles(*)')`, which
          // only works if lender_profile_id is a real FK to a different table).
          // This function was previously writing lender_users.id here instead, so every
          // match ever inserted was keyed under a value the read path never filters on —
          // deals could match, insert successfully, and still never appear on any lender's
          // pipeline. Confirmed by reading both sides of this path; not confirmed against
          // live table data (no DB access from this environment when this was written).
          const lendersRes = await fetch(
            `${SUPABASE_URL}/rest/v1/lender_users?select=id,lender_profile_id,qm_category&or=(qm_category.eq.${dealCategory},qm_category.eq.both)&limit=50`,
            { headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}` } }
          );
          const lenders = lendersRes.ok ? await lendersRes.json() : [];
          // Drop any lender_user not yet linked to a profile — inserting a match keyed
          // to a null/missing profile id would be just as invisible as the original bug.
          const routable = lenders.filter(l => l.lender_profile_id);

          if (routable.length) {
            const matchRows = routable.map(l => ({
              deal_id: savedDeal.id, lender_id: l.lender_profile_id,
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
      })() : Promise.resolve();

    // Registered, not awaited: the client gets the analysis result now; Netlify
    // keeps this invocation alive in the background until the writes finish (or
    // the function's execution-time limit is hit, whichever comes first). Each
    // task already swallows its own errors, so a failed side effect can't surface
    // here — there is deliberately nothing to catch.
    if (context && typeof context.waitUntil === "function") {
      context.waitUntil(Promise.allSettled([emailTask, notionTask, supabaseTask]));
    }

    return new Response(JSON.stringify({ success: true, analysis }), { status: 200, headers: cors });

  } catch (err) {
    return new Response(JSON.stringify({
      build: BUILD,
      error: "Server error: " + String((err && err.message) || err),
    }), { status: 200, headers: cors });
  }
};
