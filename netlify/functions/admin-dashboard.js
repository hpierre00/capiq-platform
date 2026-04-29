// Admin/operator dashboard API
// Returns platform metrics: investors, deals, revenue, lender activity
// Protected by ADMIN_SECRET env var
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
    const ADMIN_SECRET = Netlify.env.get("ADMIN_SECRET") || "underlytix-admin-2026";
    const SUPABASE_URL = "https://mxyepucitjzleaziizkr.supabase.co";
    const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY") || "";

    const body = await req.json();
    const { secret } = body;
    if (secret !== ADMIN_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

    if (!SUPABASE_KEY) throw new Error("SUPABASE_SERVICE_KEY not configured");

    const sb = (table, query) => fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" }
    }).then(r => r.json());

    const [investors, deals, lenderUsers, matches] = await Promise.all([
      sb("investors", "select=id,email,plan,analyses_this_month,created_at&order=created_at.desc"),
      sb("deals", "select=id,deal_type,asset_type,state,requested_loan_amount,created_at&order=created_at.desc&limit=50"),
      sb("lender_users", "select=id,email,plan,full_name,last_login,created_at"),
      sb("lender_matches", "select=id,interest_level,created_at&order=created_at.desc&limit=200"),
    ]);

    const proCount = Array.isArray(investors) ? investors.filter(i => i.plan === "pro").length : 0;
    const starterCount = Array.isArray(investors) ? investors.filter(i => i.plan === "starter").length : 0;
    const totalAnalysesThisMonth = Array.isArray(investors) ? investors.reduce((s, i) => s + (i.analyses_this_month || 0), 0) : 0;
    const interestedMatches = Array.isArray(matches) ? matches.filter(m => m.interest_level === "interested").length : 0;
    const termSheets = Array.isArray(matches) ? matches.filter(m => m.interest_level === "term_sheet_issued").length : 0;

    const stateBreakdown = {};
    if (Array.isArray(deals)) {
      deals.forEach(d => { stateBreakdown[d.state] = (stateBreakdown[d.state] || 0) + 1; });
    }
    const dealTypeBreakdown = {};
    if (Array.isArray(deals)) {
      deals.forEach(d => { dealTypeBreakdown[d.deal_type] = (dealTypeBreakdown[d.deal_type] || 0) + 1; });
    }

    return new Response(JSON.stringify({
      success: true,
      summary: {
        totalInvestors: Array.isArray(investors) ? investors.length : 0,
        proInvestors: proCount,
        starterInvestors: starterCount,
        estimatedMRR: proCount * 97,
        totalDeals: Array.isArray(deals) ? deals.length : 0,
        totalAnalysesThisMonth,
        totalLenderUsers: Array.isArray(lenderUsers) ? lenderUsers.length : 0,
        activeLenderUsers: Array.isArray(lenderUsers) ? lenderUsers.filter(u => u.plan === "active").length : 0,
        totalMatches: Array.isArray(matches) ? matches.length : 0,
        interestedMatches,
        termSheets,
        estimatedLenderMRR: Array.isArray(lenderUsers) ? lenderUsers.filter(u => u.plan === "active").length * 297 : 0,
      },
      recentInvestors: Array.isArray(investors) ? investors.slice(0, 10) : [],
      recentDeals: Array.isArray(deals) ? deals.slice(0, 10) : [],
      stateBreakdown,
      dealTypeBreakdown,
    }), { status: 200, headers: cors });
  } catch (e) {
    console.error("admin-dashboard error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/admin-dashboard" };
