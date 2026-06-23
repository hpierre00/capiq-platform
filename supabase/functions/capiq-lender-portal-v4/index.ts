// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const SALT = 'capiq-lender-salt-2026';
const JWT_SECRET = 'capiq-lender-jwt-2026';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  try {
    const b = await req.json();
    const { action, token, newPassword, currentPassword } = b;

    if (action === 'login') {
      const hash = await hp(b.password);
      const { data: u } = await sb.from('lender_users').select('*,lender_profiles(*)').eq('email', b.email).maybeSingle();
      if (!u || u.password_hash !== hash) return res({ error: 'Invalid credentials.' }, 401);
      await sb.from('lender_users').update({ last_login: new Date().toISOString() }).eq('id', u.id);
      return res({
        success: true,
        token: gt(u.id, u.email, u.lender_profile_id, u.role, u.qm_category || 'non_qm'),
        user: { id: u.id, email: u.email, name: u.full_name, role: u.role, qm_category: u.qm_category || 'non_qm', lender: u.lender_profiles },
      });
    }

    if (action === 'verify') {
      const p = vt(token);
      if (!p) return new Response(JSON.stringify({ valid: false }), { status: 200, headers: cors });
      const { data: u } = await sb.from('lender_users').select('*,lender_profiles(*)').eq('id', p.id).maybeSingle();
      if (!u) return new Response(JSON.stringify({ valid: false }), { status: 200, headers: cors });
      return res({ valid: true, user: { id: u.id, email: u.email, name: u.full_name, role: u.role, qm_category: u.qm_category || 'non_qm', lender: u.lender_profiles } });
    }

    if (action === 'get_deals') {
      const p = vt(token);
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
      const p = vt(token);
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
      await sb.from('lender_users').update({ password_hash: await hp(np), reset_token: null, reset_token_expires: null }).eq('id', u.id);
      return res({ success: true });
    }

    if (action === 'change_password') {
      const p = vt(token);
      if (!p) return res({ error: 'Invalid session.' }, 401);
      if (!currentPassword || !newPassword || newPassword.length < 8) return res({ error: 'All fields required. Min 8 characters.' }, 400);
      const { data: u } = await sb.from('lender_users').select('*').eq('id', p.id).maybeSingle();
      if (!u) return res({ error: 'Account not found.' }, 404);
      if (u.password_hash !== await hp(currentPassword)) return res({ error: 'Current password is incorrect.' }, 401);
      await sb.from('lender_users').update({ password_hash: await hp(newPassword) }).eq('id', p.id);
      return res({ success: true });
    }

    if (action === 'create_checkout') {
      const p = vt(token);
      if (!p) return res({ error: 'Unauthorized' }, 401);
      return res({ success: false, error: 'Upgrade not yet available online. Contact support@underlytix.com to activate full deal access.' });
    }

    return res({ error: 'Unknown action' }, 400);
  } catch (e) {
    return res({ error: e.message }, 500);
  }
});

async function hp(pw) {
  const d = new TextEncoder().encode(pw + SALT);
  const h = await crypto.subtle.digest('SHA-256', d);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function gt(id, email, lid, role, qmc) {
  const p = { id, email, lender_profile_id: lid, role, qm_category: qmc, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const d = btoa(JSON.stringify(p));
  return d + '.' + hm(d);
}

function vt(t) {
  try {
    if (!t) return null;
    const parts = t.split('.');
    const d = parts[0];
    const s = parts[1];
    if (hm(d) !== s) return null;
    const p = JSON.parse(atob(d));
    return p.exp < Date.now() ? null : p;
  } catch (_e) {
    return null;
  }
}

function hm(d) {
  const c = d + '|' + JWT_SECRET;
  let h = 0;
  for (let i = 0; i < c.length; i++) {
    h = ((h << 5) - h) + c.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36) + c.length.toString(36);
}

function res(data, s) {
  return new Response(JSON.stringify(data), { status: s || 200, headers: cors });
}
