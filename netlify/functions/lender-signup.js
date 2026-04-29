// Lender self-signup endpoint (item 10: lender onboarding flow)
// Creates a lender_users record and fires welcome email
// Lender profiles must already exist OR we create a pending profile for admin review

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
    const SUPABASE_URL = "https://mxyepucitjzleaziizkr.supabase.co";
    const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY") || "";
    const RESEND_API_KEY = Netlify.env.get("RESEND_API_KEY") || "";
    if (!SUPABASE_KEY) throw new Error("SUPABASE_SERVICE_KEY not configured");

    const body = await req.json();
    const { companyName, contactName, email, phone, password, lenderType, states, minLoan, maxLoan, minFico } = body;

    if (!email || !password || !companyName || !contactName) {
      return new Response(JSON.stringify({ error: "Company name, contact name, email, and password are required." }), { status: 400, headers: cors });
    }
    if (password.length < 8) return new Response(JSON.stringify({ error: "Password must be at least 8 characters." }), { status: 400, headers: cors });

    const sb = (path, opts) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation", ...(opts?.headers || {}) }
    }).then(r => r.json());

    // Check if email already exists in lender_users
    const existing = await sb(`lender_users?email=eq.${encodeURIComponent(email)}&select=id`);
    if (Array.isArray(existing) && existing.length > 0) {
      return new Response(JSON.stringify({ error: "An account with this email already exists." }), { status: 409, headers: cors });
    }

    // Create a pending lender profile for admin approval
    const profileRes = await sb("lender_profiles", {
      method: "POST",
      body: JSON.stringify({
        lender_name: companyName,
        lender_type: lenderType || "hard_money",
        active_status: false, // pending admin approval
        min_loan_amount: parseFloat(minLoan) || 100000,
        max_loan_amount: parseFloat(maxLoan) || 5000000,
        min_fico: parseInt(minFico) || 640,
        max_ltv: 80,
        allowed_states: states || ["FL"],
        allowed_asset_types: ["sfr", "2_4_unit"],
        priority_tier: "basic",
      }),
    });

    if (!Array.isArray(profileRes) || !profileRes[0]?.id) {
      throw new Error("Failed to create lender profile");
    }
    const profileId = profileRes[0].id;

    // Hash password
    const SALT = "capiq-lender-salt-2026";
    const enc = new TextEncoder().encode(password + SALT);
    const hashBuf = await crypto.subtle.digest("SHA-256", enc);
    const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

    // Create lender user (trial plan, 14 days)
    const userRes = await sb("lender_users", {
      method: "POST",
      body: JSON.stringify({
        lender_profile_id: profileId,
        email,
        password_hash: hash,
        full_name: contactName,
        role: "admin",
        plan: "trial",
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    });

    if (!Array.isArray(userRes) || !userRes[0]?.id) throw new Error("Failed to create lender user");

    // Fire welcome email
    if (RESEND_API_KEY) {
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Underlytix <noreply@underlytix.com>",
          to: [email],
          subject: "Welcome to Underlytix Lender Portal — 14-day trial activated",
          html: `
            <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;border:1px solid #e5e7eb">
              <div style="margin-bottom:32px"><span style="font-size:20px;font-weight:800;color:#0a1628;letter-spacing:-0.5px">UNDERLYTIX</span></div>
              <h1 style="font-size:24px;font-weight:700;color:#0a1628;margin:0 0 16px">Welcome, ${contactName}.</h1>
              <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px">Your 14-day trial is active. Log into the Lender Portal to view deals matched to ${companyName}'s criteria.</p>
              <a href="https://underlytix.com#lenders" style="display:inline-block;background:#00bfa5;color:#fff;font-weight:600;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px">Access Lender Portal →</a>
              <p style="color:#6b7280;font-size:13px;margin:32px 0 0">Login: ${email} — use the password you set during signup.</p>
            </div>
          `,
        }),
      }).catch(() => {});

      // Also notify admin
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Underlytix <noreply@underlytix.com>",
          to: ["heroldpierre@sofloam.com"],
          subject: `New lender signup: ${companyName}`,
          html: `<p>New lender signup:<br>Company: ${companyName}<br>Contact: ${contactName}<br>Email: ${email}<br>Phone: ${phone}<br>Type: ${lenderType}<br>States: ${(states||[]).join(", ")}<br>Loan range: $${minLoan} - $${maxLoan}<br>Profile ID: ${profileId}</p>`,
        }),
      }).catch(() => {});
    }

    return new Response(JSON.stringify({ success: true, message: "Account created. Your 14-day trial is now active." }), { status: 200, headers: cors });
  } catch (e) {
    console.error("lender-signup error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/lender-signup" };
