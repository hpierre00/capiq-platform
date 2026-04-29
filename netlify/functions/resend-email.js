// Resend email sender — handles welcome, analysis, upgrade, and lender notifications
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
    const RESEND_API_KEY = Netlify.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500, headers: cors });

    const body = await req.json();
    const { type, to, name, data } = body;

    let emailPayload = null;

    if (type === "welcome") {
      emailPayload = {
        from: "Underlytix <noreply@underlytix.com>",
        to: [to],
        subject: "Welcome to Underlytix — Your first analysis is on us",
        html: `
          <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;border:1px solid #e5e7eb">
            <div style="margin-bottom:32px"><span style="font-size:20px;font-weight:800;color:#0a1628;letter-spacing:-0.5px">UNDERLYTIX</span></div>
            <h1 style="font-size:24px;font-weight:700;color:#0a1628;margin:0 0 16px">Welcome, ${name}.</h1>
            <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px">Your account is active. You have <strong>3 free analyses</strong> this month — use them to stress-test your deals before approaching lenders.</p>
            <a href="https://underlytix.com" style="display:inline-block;background:#00bfa5;color:#fff;font-weight:600;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px">Run Your First Analysis →</a>
            <p style="color:#6b7280;font-size:13px;margin:32px 0 0">Need unlimited analyses? Upgrade to Pro for $97/month and get full access plus priority lender matching.</p>
          </div>
        `,
      };
    } else if (type === "analysis_complete") {
      const d = data || {};
      const score = d.fundabilityScore || d.score || "—";
      const band = d.scoreBand || d.band || "—";
      const dealCode = d.dealCode || "";
      emailPayload = {
        from: "Underlytix <noreply@underlytix.com>",
        to: [to],
        subject: `Analysis Complete: Deal ${dealCode} scored ${score}/100`,
        html: `
          <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;border:1px solid #e5e7eb">
            <div style="margin-bottom:32px"><span style="font-size:20px;font-weight:800;color:#0a1628;letter-spacing:-0.5px">UNDERLYTIX</span></div>
            <h1 style="font-size:24px;font-weight:700;color:#0a1628;margin:0 0 16px">Your analysis is ready.</h1>
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:0 0 24px">
              <div style="font-size:13px;color:#6b7280;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:4px">DEAL ${dealCode}</div>
              <div style="font-size:40px;font-weight:800;color:#0a1628">${score}<span style="font-size:20px;color:#6b7280">/100</span></div>
              <div style="font-size:15px;color:#374151;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${band}</div>
            </div>
            <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 24px">${d.executiveSummary || "Your deal has been analyzed. Log in to view the full report including lender matches and structuring recommendations."}</p>
            <a href="https://underlytix.com" style="display:inline-block;background:#0a1628;color:#fff;font-weight:600;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px">View Full Report →</a>
          </div>
        `,
      };
    } else if (type === "upgrade_confirm") {
      emailPayload = {
        from: "Underlytix <noreply@underlytix.com>",
        to: [to],
        subject: "You're now on Underlytix Pro — unlimited analyses unlocked",
        html: `
          <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;border:1px solid #e5e7eb">
            <div style="margin-bottom:32px"><span style="font-size:20px;font-weight:800;color:#0a1628;letter-spacing:-0.5px">UNDERLYTIX</span></div>
            <h1 style="font-size:24px;font-weight:700;color:#0a1628;margin:0 0 16px">Welcome to Pro, ${name}.</h1>
            <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px">Your subscription is active. You now have <strong>unlimited deal analyses</strong> every month, priority lender matching, and full access to every report feature.</p>
            <a href="https://underlytix.com" style="display:inline-block;background:#00bfa5;color:#fff;font-weight:600;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px">Start Analyzing →</a>
            <p style="color:#6b7280;font-size:13px;margin:32px 0 0">Manage your subscription at any time from the billing portal inside your account.</p>
          </div>
        `,
      };
    } else if (type === "lender_new_deal") {
      const d = data || {};
      emailPayload = {
        from: "Underlytix <noreply@underlytix.com>",
        to: [to],
        subject: `New deal match: ${d.dealType || "Deal"} in ${d.state || "—"} — Score ${d.score || "—"}/100`,
        html: `
          <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;border:1px solid #e5e7eb">
            <div style="margin-bottom:32px"><span style="font-size:20px;font-weight:800;color:#0a1628;letter-spacing:-0.5px">UNDERLYTIX</span></div>
            <h1 style="font-size:24px;font-weight:700;color:#0a1628;margin:0 0 16px">A new deal matches your criteria.</h1>
            <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div><div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Deal Type</div><div style="font-size:15px;font-weight:600;color:#0a1628">${d.dealType || "—"}</div></div>
                <div><div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">State</div><div style="font-size:15px;font-weight:600;color:#0a1628">${d.state || "—"}</div></div>
                <div><div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Loan Amount</div><div style="font-size:15px;font-weight:600;color:#0a1628">$${(d.loanAmount||0).toLocaleString()}</div></div>
                <div><div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Fundability Score</div><div style="font-size:15px;font-weight:600;color:#00bfa5">${d.score || "—"}/100</div></div>
              </div>
            </div>
            <a href="https://underlytix.com#lenders" style="display:inline-block;background:#0a1628;color:#fff;font-weight:600;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px">View in Portal →</a>
          </div>
        `,
      };
    } else {
      return new Response(JSON.stringify({ error: "Unknown email type" }), { status: 400, headers: cors });
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload),
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.message || "Resend API error");
    return new Response(JSON.stringify({ success: true, id: result.id }), { status: 200, headers: cors });
  } catch (e) {
    console.error("resend-email error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/resend-email" };
