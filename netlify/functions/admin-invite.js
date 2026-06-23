/**
 * Netlify Function: admin-invite
 *
 * Grants free access to the Underlytix Realtor Portal.
 * Admin-only. Verifies caller via Supabase JWT, then:
 *   - Updates an existing realtor_users record to plan='active'
 *   - OR creates a new realtor_users record with an invite token
 *   - Sends the user an invite / activation email via Resend
 *
 * POST body:
 *   { token, email, plan_type }
 *   token     — admin's Supabase session token
 *   email     — target user's email
 *   plan_type — 'permanent' | 'trial_30' | 'trial_14'  (default: 'permanent')
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   RESEND_API_KEY  (optional — if absent, invite link is returned in response)
 *   RESEND_FROM_EMAIL (optional, defaults to noreply@underlytix.com)
 */

const crypto = require('crypto');

const ADMIN_EMAILS     = ['hpierre00@gmail.com'];
const SUPABASE_URL     = process.env.SUPABASE_URL     || 'https://mxyepucitjzleaziizkr.supabase.co';
const SERVICE_KEY      = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL       = process.env.RESEND_FROM_EMAIL || 'Underlytix <noreply@underlytix.com>';
const SITE_URL         = process.env.SITE_URL          || 'https://underlytix.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { token, email, plan_type = 'permanent', portals = ['realtor'] } = body;

  if (!token || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'token and email are required' }) };
  }

  // Validate portals
  const validPortals = ['realtor', 'lender', 'investor'];
  const selectedPortals = Array.isArray(portals)
    ? portals.filter(p => validPortals.includes(p))
    : ['realtor'];
  if (selectedPortals.length === 0) selectedPortals.push('realtor');

  // ── 1. Verify caller is an admin ─────────────────────────────────────────────
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey:        SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  }).catch(() => null);

  if (!authRes || !authRes.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session' }) };
  }

  const authUser = await authRes.json();
  if (!ADMIN_EMAILS.includes((authUser.email || '').toLowerCase())) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Access denied' }) };
  }

  // ── 2. Determine plan ─────────────────────────────────────────────────────────
  const targetEmail = email.toLowerCase().trim();
  let   plan        = 'active';
  let   trialEndsAt = null;

  if (plan_type === 'trial_30') {
    plan        = 'trial';
    trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  } else if (plan_type === 'trial_14') {
    plan        = 'trial';
    trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  }

  // ── 3. Check whether this user already exists ─────────────────────────────────
  const findRes  = await fetch(
    `${SUPABASE_URL}/rest/v1/realtor_users?email=eq.${encodeURIComponent(targetEmail)}&select=id,email,plan`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const existing = await findRes.json();
  const userExists = Array.isArray(existing) && existing.length > 0;

  // ── 4. Upsert the user record ─────────────────────────────────────────────────
  const inviteToken    = crypto.randomBytes(32).toString('hex');
  const tokenExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(); // 72 h

  if (userExists) {
    // Existing user — just upgrade plan and give them a re-access token
    const patch = {
      plan,
      reset_token:         inviteToken,
      reset_token_expires: tokenExpiresAt,
    };
    if (trialEndsAt)  patch.trial_ends_at = trialEndsAt;
    if (plan === 'active') patch.trial_ends_at = null;

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/realtor_users?email=eq.${encodeURIComponent(targetEmail)}`,
      {
        method:  'PATCH',
        headers: {
          apikey:          SERVICE_KEY,
          Authorization:   `Bearer ${SERVICE_KEY}`,
          'Content-Type':  'application/json',
          Prefer:          'return=minimal',
        },
        body: JSON.stringify(patch),
      },
    );

    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error('[admin-invite] PATCH failed:', err);
      return { statusCode: 502, body: JSON.stringify({ error: 'Failed to update user' }) };
    }
  } else {
    // New user — create a minimal record; they'll set their password via invite link
    const now = new Date();
    const newUser = {
      email:               targetEmail,
      password_hash:       'INVITE_PENDING',   // placeholder until they set a password
      plan,
      reset_token:         inviteToken,
      reset_token_expires: tokenExpiresAt,
      prequals_this_month: 0,
      usage_reset_at:      new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
      created_at:          now.toISOString(),
    };
    if (trialEndsAt) newUser.trial_ends_at = trialEndsAt;

    const insertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/realtor_users`,
      {
        method:  'POST',
        headers: {
          apikey:          SERVICE_KEY,
          Authorization:   `Bearer ${SERVICE_KEY}`,
          'Content-Type':  'application/json',
          Prefer:          'return=minimal',
        },
        body: JSON.stringify(newUser),
      },
    );

    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('[admin-invite] INSERT failed:', err);
      return { statusCode: 502, body: JSON.stringify({ error: 'Failed to create user' }) };
    }
  }

  // ── 5. Send the email ─────────────────────────────────────────────────────────
  // Build per-portal setup links
  const portalMeta = {
    realtor:  { label: '🏠 Realtor Portal', path: '/realtor', desc: 'AI prequal, lender match, voice mode' },
    lender:   { label: '🏦 Lender Portal',   path: '/lender',   desc: 'Loan pipeline, QM analysis, pricing' },
    investor: { label: '📈 Investor Portal', path: '/investor', desc: 'Deal analysis, DSCR, cap rate tools' },
  };
  const primaryPortal  = selectedPortals[0];
  const setupLink      = `${SITE_URL}${portalMeta[primaryPortal].path}?invite_token=${inviteToken}`;
  const planLabel      = plan === 'active' ? 'full' : (plan_type === 'trial_30' ? '30-day free' : '14-day free');
  let   emailSent      = false;

  const portalButtonsHtml = selectedPortals.map(p =>
    `<a href="${SITE_URL}${portalMeta[p].path}" style="display:inline-block;margin:6px 8px 6px 0;background:#0f172a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">${portalMeta[p].label} →</a>`
  ).join('');
  const portalListText = selectedPortals.map(p => `${portalMeta[p].label} — ${portalMeta[p].desc}`).join('<br>');

  if (RESEND_API_KEY) {
    const subject = userExists
      ? 'Your Underlytix access has been activated'
      : 'You\'ve been invited to Underlytix';

    const bodyHtml = userExists
      ? `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a202c">
          <h2 style="margin-bottom:8px">Your Underlytix access is active</h2>
          <p>Your account has been upgraded to <strong>${planLabel} access</strong> for the following portals:</p>
          <p style="margin:12px 0;padding:12px 16px;background:#f8fafc;border-radius:6px;font-size:13px;color:#374151;line-height:1.8">${portalListText}</p>
          <div style="margin:16px 0">${portalButtonsHtml}</div>
          <p style="color:#718096;font-size:13px">Sign in with your existing password. If you've forgotten it, use the "Forgot password?" link on the login page.</p>
        </div>`
      : `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a202c">
          <h2 style="margin-bottom:8px">You've been invited to Underlytix</h2>
          <p>You have been granted <strong>${planLabel} access</strong> to the following portals:</p>
          <p style="margin:12px 0;padding:12px 16px;background:#f8fafc;border-radius:6px;font-size:13px;color:#374151;line-height:1.8">${portalListText}</p>
          <p><a href="${setupLink}" style="background:#00bfa5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;margin:16px 0">Set Your Password & Get Started →</a></p>
          <p style="color:#718096;font-size:13px">This setup link expires in 72 hours. After setting your password, you can access all granted portals using the same login.</p>
        </div>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: targetEmail, subject, html: bodyHtml }),
    }).catch(err => { console.error('[admin-invite] Resend error:', err.message); return null; });

    emailSent = emailRes?.ok === true;
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok:         true,
      userExists,
      email:      targetEmail,
      plan,
      emailSent,
      // Expose the setup link when email wasn't sent, so admin can share it manually
      setupLink:  (!emailSent && !userExists) ? setupLink : undefined,
    }),
  };
};
