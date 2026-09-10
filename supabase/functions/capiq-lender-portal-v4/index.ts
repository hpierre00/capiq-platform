// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const SALT = 'capiq-lender-salt-2026'; // legacy SHA-256 salt — verify-only fallback for un-upgraded hashes
const PBKDF2_ITERATIONS = 210000;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  try {
    const b = await req.json();
    const { action, token, newPassword, currentPassword } = b;

    if (action === 'login') {
      const { data: u } = await sb.from('lender_users').select('*,lender_profiles(*)').eq('email', b.email).maybeSingle();
      if (!u || !(await verifyHash(b.password, u.password_hash))) return res({ error: 'Invalid credentials.' }, 401);
      if (!u.password_hash?.startsWith('pbkdf2$')) {
        await sb.from('lender_users').update({ password_hash: await newHash(b.password) }).eq('id', u.id);
      }
      await sb.from('lender_users').update({ last_login: new Date().toISOString() }).eq('id', u.id);
      return res({
        success: true,
        token: await gt(u.id, u.email, u.lender_profile_id, u.role, u.qm_category || 'non_qm'),
        user: { id: u.id, email: u.email, name: u.full_name, role: u.role, qm_category: u.qm_category || 'non_qm', lender: u.lender_profiles },
      });
    }

    if (action === 'verify') {
      const p = await vt(token);
      if (!p) return new Response(JSON.stringify({ valid: false }), { status: 200, headers: cors });
      const { data: u } = await sb.from('lender_users').select('*,lender_profiles(*)').eq('id', p.id).maybeSingle();
      if (!u) return new Response(JSON.stringify({ valid: false }), { status: 200, headers: cors });
      return res({ valid: true, user: { id: u.id, email: u.email, name: u.full_name, role: u.role, qm_category: u.qm_category || 'non_qm', lender: u.lender_profiles } });
    }

    if (action === 'get_deals') {
      const p = await vt(token);
      if (!p) return res({ error: 'Unauthorized' }, 401);
      // Get current lender's qm_category to filter deals
      const { data: lenderRow } = await sb.from('lender_users').select('qm_category').eq('id', p.id).maybeSingle();
      const qmCat = (lenderRow && lenderRow.qm_category) || 'non_qm';
      const { data: matches } = await sb
        .from('lender_matches')
        .select('id,match_status,match_score,interest_level,lender_notes,reviewed_at,deal_submissions(id,property_address,city,state,deal_type,asset_type,deal_category,requested_loan_amount,requested_ltv,dscr,arv,rehab_budget,monthly_rent,investor_name,borrowers(borrower_name,fico,experience_level,experience_count))')
        .eq('lender_id', p.lender_profile_id)
        .order('created_at', { ascending: false });
      const dealIds = (matches || []).map((m) => m.deal_submissions && m.deal_submissions.id).filter(Boolean);
      const scoresMap = {};
      if (dealIds.length > 0) {
        const { data: scores } = await sb
          .from('deal_scores')
          .select('deal_id,total_fundability_score,score_band,rationale_json,risk_flags_json')
          .in('deal_id', dealIds);
        (scores || []).forEach((s) => { scoresMap[s.deal_id] = s; });
      }
      const enriched = (matches || []).map((m) => ({ ...m, deal_scores: scoresMap[m.deal_submissions && m.deal_submissions.id] || null }));
      // Filter by qm_category: 'both' lenders see everything; others see only their category
      const filtered = qmCat === 'both'
        ? enriched
        : enriched.filter((m) => {
            const cat = m.deal_submissions && m.deal_submissions.deal_category;
            return !cat || cat === qmCat;
          });
      return res({ success: true, matches: filtered });
    }

    if (action === 'update_match') {
      const p = await vt(token);
      if (!p) return res({ error: 'Unauthorized' }, 401);
      await sb.from('lender_matches').update({ interest_level: b.status, lender_notes: b.notes || null, reviewed_at: new Date().toISOString(), reviewed_by: p.id }).eq('id', b.matchId);
      return res({ success: true });
    }

    if (action === 'reset_password') {
      const { email: resetEmail, token: resetToken, newPassword: np } = b;
      if (!resetToken || !np || np.length < 8) return res({ error: 'Invalid request.' }, 400);
      const { data: u } = await sb.from('lender_users').select('*').eq('email', resetEmail || '').maybeSingle();
      if (!u || u.reset_token !== resetToken) return res({ error: 'Invalid or expired reset link.' }, 400);
      if (u.reset_token_expires && new Date(u.reset_token_expires) < new Date()) return res({ error: 'Reset link has expired. Please request a new one.' }, 400);
      await sb.from('lender_users').update({ password_hash: await newHash(np), reset_token: null, reset_token_expires: null }).eq('id', u.id);
      return res({ success: true });
    }

    if (action === 'change_password') {
      const p = await vt(token);
      if (!p) return res({ error: 'Invalid session.' }, 401);
      if (!currentPassword || !newPassword || newPassword.length < 8) return res({ error: 'All fields required. Min 8 characters.' }, 400);
      const { data: u } = await sb.from('lender_users').select('*').eq('id', p.id).maybeSingle();
      if (!u) return res({ error: 'Account not found.' }, 404);
      if (!(await verifyHash(currentPassword, u.password_hash))) return res({ error: 'Current password is incorrect.' }, 401);
      await sb.from('lender_users').update({ password_hash: await newHash(newPassword) }).eq('id', p.id);
      return res({ success: true });
    }

    if (action === 'create_checkout') {
      const p = await vt(token);
      if (!p) return res({ error: 'Unauthorized' }, 401);
      return res({ success: false, error: 'Upgrade not yet available online. Contact support@underlytix.com to activate full deal access.' });
    }

    return res({ error: 'Unknown action' }, 400);
  } catch (e) {
    return res({ error: e.message }, 500);
  }
});

// ── Password hashing ─────────────────────────────────────────────────────────
async function legacyHash(pw) {
  const d = new TextEncoder().encode(pw + SALT);
  const h = await crypto.subtle.digest('SHA-256', d);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function newHash(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, km, 256);
  return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' + btoa(String.fromCharCode(...salt)) + '$' + btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function verifyHash(pw, stored) {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    if (parts.length !== 4) return false;
    const iter = parseInt(parts[1], 10);
    const salt = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, 256);
    const got = btoa(String.fromCharCode(...new Uint8Array(bits)));
    const exp = parts[3];
    if (got.length !== exp.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ exp.charCodeAt(i);
    return diff === 0;
  }
  return stored === await legacyHash(pw);
}

// ── Session token: HMAC-SHA256, key derived from the service-role key ─────────
let _hmacKey = null;
async function hmacKey() {
  if (_hmacKey) return _hmacKey;
  const root = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const rk = await crypto.subtle.importKey('raw', new TextEncoder().encode(root), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', rk, new TextEncoder().encode('capiq-lender-legacy-token-v1'));
  _hmacKey = await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return _hmacKey;
}

async function hmSign(d) {
  const key = await hmacKey();
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(d));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function gt(id, email, lid, role, qmc) {
  const p = { id, email, lender_profile_id: lid, role, qm_category: qmc, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const d = btoa(JSON.stringify(p));
  return d + '.' + await hmSign(d);
}

async function vt(t) {
  try {
    if (!t) return null;
    const [d, s] = t.split('.');
    if (!d || !s) return null;
    const expected = await hmSign(d);
    if (expected.length !== s.length) return null;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= expected.charCodeAt(i) ^ s.charCodeAt(i);
    if (diff !== 0) return null;
    const p = JSON.parse(atob(d));
    return p.exp < Date.now() ? null : p;
  } catch (_e) {
    return null;
  }
}

function res(data, s) {
  return new Response(JSON.stringify(data), { status: s || 200, headers: cors });
}
