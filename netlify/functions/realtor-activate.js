/**
 * Netlify Function: realtor-activate
 *
 * Completes an admin-issued invite: the user sets their password,
 * a Supabase auth account is created, and a realtor session is returned.
 *
 * POST body: { invite_token, email, password, name }
 *   invite_token — token stored in realtor_users.reset_token
 *   email        — user's email (double-checked against DB)
 *   password     — chosen password (min 8 chars)
 *   name         — optional display name
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mxyepucitjzleaziizkr.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const AUTH_FN_URL  = `${SUPABASE_URL}/functions/v1/capiq-realtor-auth-v5`;

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

  const { invite_token, email, password, name } = body;

  if (!invite_token || !email || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invite_token, email, and password are required' }) };
  }

  if (password.length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
  }

  const targetEmail = email.toLowerCase().trim();

  // ── 1. Validate invite token ──────────────────────────────────────────────────
  const findRes = await fetch(
    `${SUPABASE_URL}/rest/v1/realtor_users?email=eq.${encodeURIComponent(targetEmail)}&reset_token=eq.${invite_token}&select=id,email,plan,reset_token_expires,supabase_uid`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );

  const rows = await findRes.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or expired invite link' }) };
  }

  const record = rows[0];
  if (record.reset_token_expires && new Date() > new Date(record.reset_token_expires)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invite link has expired. Ask your admin to resend.' }) };
  }

  // ── 2. Create or update Supabase Auth user ────────────────────────────────────
  let supabaseUid = record.supabase_uid;

  if (!supabaseUid) {
    // Create new Supabase Auth user via admin API
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method:  'POST',
      headers: {
        apikey:          SERVICE_KEY,
        Authorization:   `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        email:         targetEmail,
        password,
        email_confirm: true,  // skip email confirmation — admin already verified
        user_metadata: { name: name || '' },
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      // If the user already exists in Auth, retrieve their UID instead
      if (createRes.status === 422 || err.includes('already been registered')) {
        // Look up by email
        const listRes = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(targetEmail)}`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        );
        if (listRes.ok) {
          const listData = await listRes.json();
          supabaseUid = listData.users?.[0]?.id;
        }
      }
      if (!supabaseUid) {
        console.error('[realtor-activate] Auth user creation failed:', err);
        return { statusCode: 502, body: JSON.stringify({ error: 'Failed to create account. Please contact support.' }) };
      }
    } else {
      const created = await createRes.json();
      supabaseUid = created.id;
    }
  } else {
    // Auth user exists — update their password
    const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${supabaseUid}`, {
      method:  'PUT',
      headers: {
        apikey:          SERVICE_KEY,
        Authorization:   `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ password, email_confirm: true }),
    });

    if (!updateRes.ok) {
      const err = await updateRes.text();
      console.error('[realtor-activate] Password update failed:', err);
      return { statusCode: 502, body: JSON.stringify({ error: 'Failed to set password. Please contact support.' }) };
    }
  }

  // ── 3. Update realtor_users: link UID, clear invite token ─────────────────────
  const patch = {
    supabase_uid:        supabaseUid,
    password_hash:       'SUPABASE_AUTH',  // signal that auth is handled by Supabase
    reset_token:         null,
    reset_token_expires: null,
  };
  if (name) patch.full_name = name;

  await fetch(
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

  // ── 4. Sign them in via the realtor auth edge function ────────────────────────
  const loginRes = await fetch(AUTH_FN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'login', email: targetEmail, password }),
  }).catch(() => null);

  if (loginRes?.ok) {
    const loginData = await loginRes.json();
    if (loginData.success) {
      return {
        statusCode: 200,
        headers:    { 'Content-Type': 'application/json' },
        body:       JSON.stringify({ ok: true, autoLogin: true, ...loginData }),
      };
    }
  }

  // Fallback: activation succeeded but auto-login failed — user can log in manually
  return {
    statusCode: 200,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify({ ok: true, autoLogin: false, email: targetEmail }),
  };
};
