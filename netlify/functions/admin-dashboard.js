// Admin/operator dashboard — routes through admin-metrics Supabase edge function
// Protected by ADMIN_SECRET (same secret shared with the edge function)
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
    const body = await req.json();
    const { secret } = body;
    if (!secret) return new Response(JSON.stringify({ error: "Secret required" }), { status: 401, headers: cors });

    // Proxy to Supabase admin-metrics edge function (has service_role access)
    const res = await fetch("https://mxyepucitjzleaziizkr.supabase.co/functions/v1/admin-metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    });

    const data = await res.json();
    return new Response(JSON.stringify(data), { status: res.status, headers: cors });
  } catch (e) {
    console.error("admin-dashboard error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/admin-dashboard" };
