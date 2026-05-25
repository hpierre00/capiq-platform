import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const SALT = 'capiq-realtor-salt-2026';
const JWT_KEY = 'capiq-realtor-jwt-2026';
const TTL = 7 * 24 * 60 * 60 * 1000;
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  const SB = Deno.env.get('SUPABASE_URL')!;
  const SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const AK = Deno.env.get('SUPABASE_ANON_KEY')!;
  const sb = createClient(SB, SK, { auth: { autoRefreshToken: false, persistSession: false } });
  const sa = createClient(SB, AK, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const b = await req.json();
    const { action, email, password, token, newPassword, currentPassword } = b;
    if (action === 'login') {
      const { data: r } = await sb.from('realtor_users').select('*').eq('email', email).maybeSingle();
      if (!r) return R({ error: 'No account found with this email.' }, 401);
      const { data: s } = await sa.auth.signInWithPassword({ email, password });
      if (s?.session) { await sb.from('realtor_users').update({ last_login: new Date().toISOString() }).eq('id', r.id); return R({ success: true, token: s.session.access_token, refresh_token: s.session.refresh_token, realtor: sf(r) }); }
      if (r.password_hash !== await hp(password)) return R({ error: 'Incorrect password.' }, 401);
      await sb.from('realtor_users').update({ last_login: new Date().toISOString() }).eq('id', r.id);
      const { data: au } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
      if (au?.user) { await sb.from('realtor_users').update({ supabase_uid: au.user.id }).eq('id', r.id); const { data: s2 } = await sa.auth.signInWithPassword({ email, password }); if (s2?.session) return R({ success: true, token: s2.session.access_token, refresh_token: s2.session.refresh_token, realtor: sf(r) }); }
      return R({ success: true, token: gt(r.id, r.email), realtor: sf(r) });
    }
    if (action === 'signup') {
      if (!email || !password || password.length < 8) return R({ error: password?.length < 8 ? 'Password must be at least 8 characters.' : 'Email and password required.' }, 400);
      const { data: ex } = await sb.from('realtor_users').select('id').eq('email', email).maybeSingle();
      if (ex) return R({ error: 'Account already exists.' }, 409);
      const { data: au } = await sb.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role: 'realtor', name: b.fullName || '' } });
      const uid = au?.user?.id || null;
      const { data: r, error: ce } = await sb.from('realtor_users').insert({ email, password_hash: await hp(password), full_name: b.fullName || '', license_number: b.licenseNumber || '', brokerage: b.brokerage || '', phone: b.phone || '', state: b.state || 'FL', plan: 'trial', prequals_this_month: 0, supabase_uid: uid }).select('*').single();
      if (ce) return R({ error: ce.message }, 400);
      fetch('https://hook.us2.make.com/7f3lfj2en6v8jgs0kxfjkjdeijixutri', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: r.email, name: r.full_name, brokerage: r.brokerage, license_number: r.license_number, state: r.state, phone: r.phone, plan: 'trial' }) }).catch(() => {});
      const { data: s } = await sa.auth.signInWithPassword({ email, password });
      if (s?.session) return R({ success: true, token: s.session.access_token, refresh_token: s.session.refresh_token, realtor: sf(r) });
      return R({ success: true, token: gt(r.id, r.email), realtor: sf(r) });
    }
    if (action === 'verify') {
      if (!token) return new Response(JSON.stringify({ valid: false }), { status: 200, headers: cors });
      if (token.split('.').length === 3) { const { data: { user } } = await sa.auth.getUser(token); if (user) { const { data: r } = await sb.from('realtor_users').select('*').eq('email', user.email).maybeSingle(); if (r) return new Response(JSON.stringify({ valid: true, realtor: sf(r) }), { status: 200, headers: cors }); } }
      const p = vt(token); if (p) { const { data: r } = await sb.from('realtor_users').select('*').eq('id', p.id).maybeSingle(); if (r) return new Response(JSON.stringify({ valid: true, realtor: sf(r) }), { status: 200, headers: cors }); }
      return new Response(JSON.stringify({ valid: false }), { status: 200, headers: cors });
    }
    if (action === 'refresh') {
      const rt = b.refresh_token; if (!rt) return R({ error: 'refresh_token required.' }, 400);
      const { data: { session }, error } = await sa.auth.refreshSession({ refresh_token: rt });
      if (error || !session) return R({ error: 'Session expired. Please sign in again.' }, 401);
      const { data: r } = await sb.from('realtor_users').select('*').eq('email', session.user.email).maybeSingle();
      return R({ success: true, token: session.access_token, refresh_token: session.refresh_token, realtor: sf(r) });
    }
    if (action === 'increment_usage') {
      let rid: string | null = null;
      if (token?.split('.').length === 3) { const { data: { user } } = await sa.auth.getUser(token); if (user) { const { data: r } = await sb.from('realtor_users').select('id').eq('email', user.email).maybeSingle(); if (r) rid = r.id; } } else { const p = vt(token); if (p) rid = p.id; }
      if (!rid) return R({ error: 'Invalid session.' }, 401);
      const { data: r } = await sb.from('realtor_users').select('*').eq('id', rid).maybeSingle();
      if (!r) return R({ error: 'Not found.' }, 404);
      const now = new Date(); const ra = new Date(r.usage_reset_at || new Date(now.getFullYear(), now.getMonth() + 1, 1));
      if (now >= ra) { await sb.from('realtor_users').update({ prequals_this_month: 1, usage_reset_at: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString() }).eq('id', r.id); return R({ success: true, prequals_this_month: 1 }); }
      await sb.from('realtor_users').update({ prequals_this_month: (r.prequals_this_month || 0) + 1 }).eq('id', r.id);
      return R({ success: true, prequals_this_month: (r.prequals_this_month || 0) + 1 });
    }
    if (action === 'reset_password') {
      const re2 = b.email; const rt = b.token; const np = b.newPassword;
      if (!rt || !np || np.length < 8) return R({ error: 'Invalid request.' }, 400);
      const { data: r } = await sb.from('realtor_users').select('*').eq('email', re2 || '').maybeSingle();
      if (!r || r.reset_token !== rt) return R({ error: 'Invalid or expired reset link.' }, 400);
      if (r.reset_token_expires && new Date(r.reset_token_expires) < new Date()) return R({ error: 'Reset link expired.' }, 400);
      await sb.from('realtor_users').update({ password_hash: await hp(np), reset_token: null, reset_token_expires: null }).eq('id', r.id);
      if (r.supabase_uid) await sb.auth.admin.updateUserById(r.supabase_uid, { password: np });
      return R({ success: true });
    }
    if (action === 'change_password') {
      if (!currentPassword || !newPassword || newPassword.length < 8) return R({ error: 'All fields required.' }, 400);
      let rid: string | null = null;
      if (token?.split('.').length === 3) { const { data: { user } } = await sa.auth.getUser(token); if (user) { const { data: r } = await sb.from('realtor_users').select('id').eq('email', user.email).maybeSingle(); if (r) rid = r.id; } } else { const p = vt(token); if (p) rid = p.id; }
      if (!rid) return R({ error: 'Invalid session.' }, 401);
      const { data: r } = await sb.from('realtor_users').select('*').eq('id', rid).maybeSingle();
      if (!r) return R({ error: 'Not found.' }, 404);
      const { error: ve } = await sa.auth.signInWithPassword({ email: r.email, password: currentPassword });
      if (ve && r.password_hash !== await hp(currentPassword)) return R({ error: 'Current password is incorrect.' }, 401);
      await sb.from('realtor_users').update({ password_hash: await hp(newPassword) }).eq('id', r.id);
      if (r.supabase_uid) await sb.auth.admin.updateUserById(r.supabase_uid, { password: newPassword });
      return R({ success: true });
    }
    return R({ error: 'Unknown action.' }, 400);
  } catch (e: any) { return new Response(JSON.stringify({ error: 'Server error', message: e.message }), { status: 500, headers: cors }); }
});
async function hp(pw: string): Promise<string> { const d = new TextEncoder().encode(pw + SALT); const h = await crypto.subtle.digest('SHA-256', d); return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join(''); }
function gt(id: string, email: string): string { const p = { id, email, role: 'realtor', iat: Date.now(), exp: Date.now() + TTL }; const d = btoa(JSON.stringify(p)); return d + '.' + hm(d); }
function vt(t: string): any { try { if (!t) return null; const [d, s] = t.split('.'); if (hm(d) !== s) return null; const p = JSON.parse(atob(d)); return p.exp < Date.now() ? null : p; } catch { return null; } }
function hm(d: string): string { const c = d + '|' + JWT_KEY; let h = 0; for (let i = 0; i < c.length; i++) { h = ((h << 5) - h) + c.charCodeAt(i); h |= 0; } return Math.abs(h).toString(36) + c.length.toString(36); }
function sf(r: any) { return { id: r.id, email: r.email, name: r.full_name, plan: r.plan, licenseNumber: r.license_number, brokerage: r.brokerage, state: r.state, prequals_this_month: r.prequals_this_month, trial_ends_at: r.trial_ends_at }; }
function R(data: any, s = 200) { return new Response(JSON.stringify(data), { status: s, headers: cors }); }
