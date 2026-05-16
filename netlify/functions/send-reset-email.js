// Password reset email sender — handles investor, realtor, and lender resets
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
    const SUPABASE_URL = "https://mxyepucitjzleaziizkr.supabase.co";
    const SUPABASE_SERVICE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY") || "";
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");

    const body = await req.json();
    const { email, resetToken, userType = "investor" } = body;
    if (!email) throw new Error("Email required");

    const SITE_URL = Netlify.env.get("SITE_URL") || "https://underlytix.com";

    // For realtor and lender — generate a token and store it; investor uses passed token
    let token = resetToken;
    let resetUrl = "";
    let subject = "";
    let portalLabel = "";

    if (userType === "realtor") {
      // Generate a reset token and store in realtor_users table
      token = crypto.randomUUID().replace(/-/g, "");
      const expires = new Date(Date.now() + 3600000).toISOString(); // 1 hour
      if (SUPABASE_SERVICE_KEY) {
        await fetch(`${SUPABASE_URL}/rest/v1/realtor_users?email=eq.${encodeURIComponent(email)}`, {
          method: "PATCH",
          headers: {
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reset_token: token, reset_token_expires: expires }),
        });
      }
      resetUrl = `${SITE_URL}/app?realtor_reset_token=${token}&email=${encodeURIComponent(email)}`;
      subject = "Reset your Underlytix Realtor password";
      portalLabel = "Realtor Portal";
    } else if (userType === "lender") {
      token = crypto.randomUUID().replace(/-/g, "");
      const expires = new Date(Date.now() + 3600000).toISOString();
      if (SUPABASE_SERVICE_KEY) {
        await fetch(`${SUPABASE_URL}/rest/v1/lender_users?email=eq.${encodeURIComponent(email)}`, {
          method: "PATCH",
          headers: {
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reset_token: token, reset_token_expires: expires }),
        });
      }
      resetUrl = `${SITE_URL}/app?lender_reset_token=${token}&email=${encodeURIComponent(email)}`;
      subject = "Reset your Underlytix Lender password";
      portalLabel = "Lender Portal";
    } else {
      // Investor — uses token from Supabase auth
      if (!token) {
        // Request token from investor auth edge function
        const r = await fetch(`${SUPABASE_URL}/functions/v1/capiq-auth-v3`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reset_request", email }),
        });
        const d = await r.json();
        token = d.resetToken || "";
      }
      resetUrl = `${SITE_URL}/app?reset_token=${token}&email=${encodeURIComponent(email)}`;
      subject = "Reset your Underlytix password";
      portalLabel = "Investor Portal";
    }

    const emailPayload = {
      from: "Underlytix <noreply@underlytix.com>",
      to: [email],
      subject,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;border:1px solid #e5e7eb">
          <div style="margin-bottom:32px"><span style="font-size:20px;font-weight:800;color:#0a1628;letter-spacing:-0.5px">UNDERLYTIX</span></div>
          <h1 style="font-size:24px;font-weight:700;color:#0a1628;margin:0 0 12px">Reset your ${portalLabel} password</h1>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px">Click the button below to reset your password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#00bfa5;color:#fff;font-weight:600;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px">Reset Password →</a>
          <p style="color:#6b7280;font-size:13px;margin:32px 0 0">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
        </div>
      `,
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error("Resend error:", JSON.stringify(err));
    }

    // Always return success — don't reveal whether the email exists
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: cors });

  } catch (err) {
    console.error("send-reset-email error:", err.message);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: cors }); // still 200 — don't leak errors
  }
};
