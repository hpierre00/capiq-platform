// Password reset email sender
// Called by the frontend after reset_request action, receives the reset token from Supabase response
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
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");

    const body = await req.json();
    const { email, resetToken } = body;
    if (!email) throw new Error("Email required");

    const SITE_URL = Netlify.env.get("SITE_URL") || "https://underlytix.com";
    const resetUrl = `${SITE_URL}/?reset_token=${resetToken}&email=${encodeURIComponent(email)}`;

    const emailPayload = {
      from: "Underlytix <noreply@underlytix.com>",
      to: [email],
      subject: "Reset your Underlytix password",
      html: `
        <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;border:1px solid #e5e7eb">
          <div style="margin-bottom:32px"><span style="font-size:20px;font-weight:800;color:#0a1628;letter-spacing:-0.5px">UNDERLYTIX</span></div>
          <h1 style="font-size:24px;font-weight:700;color:#0a1628;margin:0 0 16px">Reset your password</h1>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px">Click the button below to reset your password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#00bfa5;color:#fff;font-weight:600;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px">Reset Password</a>
          <p style="color:#6b7280;font-size:13px;margin:32px 0 0">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || "Resend API error");
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: cors });
  } catch (e) {
    console.error("send-reset-email error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/send-reset-email" };
