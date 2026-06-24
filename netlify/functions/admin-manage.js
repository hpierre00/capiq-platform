/**
 * Netlify Function: admin-manage
 *
 * Admin-only user management:
 *   list_users  — paginated list of realtor_users
 *   suspend     — sets plan='suspended'
 *   terminate   — sets plan='terminated'
 *   reinstate   — restores plan='active'
 *
 * POST body:
 *   { token, action, email? }
 *   token  — admin's Supabase session token
 *   action — 'list_users' | 'suspend' | 'terminate' | 'reinstate'
 *   email  — target user email (required for suspend / terminate / reinstate)
 */

const ADMIN_EMAILS = ['hpierre00@gmail.com'];
const SUPABASE_URL = process.env.SUPABASE_URL  || 'https://mxyepucitjzleaziizkr.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
// Anon key used as project identifier when verifying user JWTs.
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14eWVwdWNpdGp6bGVhemlpemtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0Njk1ODIsImV4cCI6MjA5MDA0NTU4Mn0.oQr_hO5fVkOhGcJ2u3mqQDJIfw9cAdXwfVAAXOf96q4';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try   { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { token, action, email } = body;
  if (!token || !action) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'token and action are required' }) };
  }

  // ── Verify caller is admin ────────────────────────────────────────────────────
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  }).catch(() => null);

  if (!authRes?.ok) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired session' }) };
  }
  const authUser = await authRes.json();
  if (!ADMIN_EMAILS.includes((authUser.email || '').toLowerCase())) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Access denied' }) };
  }

  // ── list_users ────────────────────────────────────────────────────────────────
  if (action === 'list_users') {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/realtor_users?select=id,email,plan,trial_ends_at,created_at,prequals_this_month&order=created_at.desc&limit=200`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    if (!res.ok) {
      const err = await res.text();
      console.error('[admin-manage] list_users failed:', err);
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Failed to fetch users' }) };
    }
    const users = await res.json();
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, users }) };
  }

  // ── suspend / terminate / reinstate ──────────────────────────────────────────
  if (['suspend', 'terminate', 'reinstate'].includes(action)) {
    if (!email) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email is required for this action' }) };
    }
    const targetEmail = email.toLowerCase().trim();

    const planMap = {
      suspend:   { plan: 'suspended' },
      terminate: { plan: 'terminated' },
      reinstate: { plan: 'active', trial_ends_at: null },
    };

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/realtor_users?email=eq.${encodeURIComponent(targetEmail)}`,
      {
        method:  'PATCH',
        headers: {
          apikey:         SERVICE_KEY,
          Authorization:  `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer:         'return=minimal',
        },
        body: JSON.stringify(planMap[action]),
      },
    );

    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error(`[admin-manage] ${action} failed:`, err);
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: `Failed to ${action} user` }) };
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ ok: true, email: targetEmail, action }),
    };
  }

  return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };
};
