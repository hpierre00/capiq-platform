// Admin dashboard — directly queries Supabase with service role key
// Protected by ADMIN_SECRET env var (default: underlytix-admin-2026)
export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });

  const ADMIN_SECRET = Netlify.env.get("ADMIN_SECRET") || "underlytix-admin-2026";
  const SVC_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
  const SB = "https://mxyepucitjzleaziizkr.supabase.co";

  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });

  try {
    const body = await req.json();
    const { secret, action } = body;

    if (secret !== ADMIN_SECRET) return reply({ error: "Invalid admin password." }, 401);
    if (!SVC_KEY) return reply({ error: "Service key not configured." }, 500);

    const sbHeaders = { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, "Content-Type": "application/json" };

    const qFetch = async (table, qs = "") => {
      const r = await fetch(`${SB}/rest/v1/${table}?${qs}`, { headers: sbHeaders });
      return r.ok ? r.json() : [];
    };

    // ── manage_user: suspend/activate/cancel ────────────────────────────────
    if (action === "manage_user") {
      const { table, userId, operation } = body;
      const tableMap = { investors: "investors", realtors: "realtor_users", lenders: "lender_users" };
      const dbTable = tableMap[table];
      if (!dbTable || !userId) return reply({ error: "Invalid request." }, 400);

      let patch = {};
      if (operation === "suspend") patch = { plan: "suspended" };
      else if (operation === "activate") patch = { plan: "active" };
      else if (operation === "cancel") patch = { plan: "cancelled" };
      else return reply({ error: "Unknown operation." }, 400);

      const r = await fetch(`${SB}/rest/v1/${dbTable}?id=eq.${userId}`, {
        method: "PATCH",
        headers: sbHeaders,
        body: JSON.stringify(patch),
      });
      return reply({ success: r.ok });
    }

    // ── main dashboard data ─────────────────────────────────────────────────
    const [investors, realtors, lenders, deals, prequals] = await Promise.all([
      qFetch("investors", "select=id,email,name,plan,analyses_this_month,created_at&order=created_at.desc"),
      qFetch("realtor_users", "select=id,email,full_name,plan,trial_ends_at,last_login,created_at&order=created_at.desc"),
      qFetch("lender_users", "select=id,email,full_name,plan,qm_category,last_login,created_at&order=created_at.desc"),
      qFetch("deal_submissions", "select=id,deal_type,asset_type,state,deal_category,requested_loan_amount,investor_name,investor_email,created_at&order=created_at.desc&limit=100"),
      qFetch("client_prequals", "select=id,client_name,client_email,client_phone,loan_type,prequal_result,state,realtor_id,created_at&order=created_at.desc&limit=100"),
    ]);

    return reply({
      success: true,
      investors: investors || [],
      realtors: realtors || [],
      lenders: lenders || [],
      deals: deals || [],
      prequals: prequals || [],
    });

  } catch (e) {
    console.error("admin-dashboard error:", e.message);
    return reply({ error: e.message }, 500);
  }
};

export const config = { path: "/.netlify/functions/admin-dashboard" };
