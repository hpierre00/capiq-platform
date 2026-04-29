// Lender self-signup — routes through capiq-lender-portal-v2 Supabase edge function
// No SUPABASE_SERVICE_KEY needed — the edge function has it auto-injected
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

    // Proxy to Supabase edge function which has service_role access
    const res = await fetch("https://mxyepucitjzleaziizkr.supabase.co/functions/v1/capiq-lender-portal-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "signup", ...body }),
    });

    const data = await res.json();

    // If signup succeeded, fire welcome email + admin notification via Resend
    if (data.success) {
      const RESEND_API_KEY = Netlify.env.get("RESEND_API_KEY") || "";
      if (RESEND_API_KEY) {
        // Welcome email to new lender
        fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Underlytix <noreply@underlytix.com>",
            to: [body.email],
            subject: "Welcome to Underlytix Lender Portal — 14-day trial activated",
            html: `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:40px">
              <div style="font-size:20px;font-weight:800;color:#0a1628;margin-bottom:24px">UNDERLYTIX</div>
              <h1 style="font-size:22px;color:#0a1628">Welcome, ${body.contactName}.</h1>
              <p style="color:#374151;font-size:15px;line-height:1.6">Your 14-day trial is active. Sign in to view deals matched to ${body.companyName}'s criteria.</p>
              <a href="https://underlytix.com#lenders" style="display:inline-block;background:#00bfa5;color:#fff;font-weight:600;padding:14px 28px;border-radius:8px;text-decoration:none;margin:16px 0">Access Lender Portal →</a>
              <p style="color:#6b7280;font-size:13px">Login: ${body.email} — use the password you set during signup.</p>
            </div>`,
          }),
        }).catch(() => {});

        // Admin notification
        fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Underlytix <noreply@underlytix.com>",
            to: ["heroldpierre@sofloam.com"],
            subject: `New lender signup: ${body.companyName}`,
            html: `<p><b>New lender signup</b><br>Company: ${body.companyName}<br>Contact: ${body.contactName}<br>Email: ${body.email}<br>Phone: ${body.phone||'—'}<br>Type: ${body.lenderType}<br>States: ${(body.states||[]).join(', ')}<br>Loan range: $${body.minLoan||'?'} – $${body.maxLoan||'?'}</p><p>Approve in Supabase: set lender_profiles.active_status = true</p>`,
          }),
        }).catch(() => {});
      }
    }

    return new Response(JSON.stringify(data), { status: res.status, headers: cors });
  } catch (e) {
    console.error("lender-signup error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/lender-signup" };
