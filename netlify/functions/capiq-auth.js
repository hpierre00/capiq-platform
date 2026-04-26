import crypto from 'crypto';

const SUPABASE_URL = 'https://mxyepucitjzleaziizkr.supabase.co';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });

  try {
    const serviceKey = Netlify.env.get('SUPABASE_SERVICE_KEY');
    const jwtSecret = Netlify.env.get('JWT_SECRET') || 'capiq-jwt-secret-2026';
    const body = await req.json();
    const { action, email, password, name, phone } = body;

    const headers = {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    };

    if (action === 'signup') {
      // Check email not already registered
      const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/investors?email=eq.${encodeURIComponent(email)}&select=id`, { headers });
      const existing = await checkRes.json();
      if (existing.length > 0) return new Response(JSON.stringify({ error: 'An account with this email already exists.' }), { status: 409, headers: cors });

      // Hash password
      const hash = crypto.createHash('sha256').update(password + 'capiq-salt-2026').digest('hex');

      // Create investor
      const createRes = await fetch(`${SUPABASE_URL}/rest/v1/investors`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ email, password_hash: hash, name: name || '', plan: 'starter', analyses_this_month: 0 }),
      });
      const investor = await createRes.json();
      if (!createRes.ok) return new Response(JSON.stringify({ error: investor.message || 'Signup failed' }), { status: 400, headers: cors });

      const inv = Array.isArray(investor) ? investor[0] : investor;
      const token = generateToken(inv.id, inv.email, inv.plan, jwtSecret);
      return new Response(JSON.stringify({ success: true, token, investor: safeInvestor(inv) }), { status: 200, headers: cors });
    }

    if (action === 'login') {
      const hash = crypto.createHash('sha256').update(password + 'capiq-salt-2026').digest('hex');
      const loginRes = await fetch(`${SUPABASE_URL}/rest/v1/investors?email=eq.${encodeURIComponent(email)}&select=*`, { headers });
      const investors = await loginRes.json();
      if (!investors.length) return new Response(JSON.stringify({ error: 'No account found with this email.' }), { status: 401, headers: cors });
      const inv = investors[0];
      if (inv.password_hash !== hash) return new Response(JSON.stringify({ error: 'Incorrect password.' }), { status: 401, headers: cors });
      const token = generateToken(inv.id, inv.email, inv.plan, jwtSecret);
      return new Response(JSON.stringify({ success: true, token, investor: safeInvestor(inv) }), { status: 200, headers: cors });
    }

    if (action === 'verify') {
      const { token } = body;
      const payload = verifyToken(token, jwtSecret);
      if (!payload) return new Response(JSON.stringify({ valid: false, error: 'Invalid or expired session.' }), { status: 401, headers: cors });

      // Refresh investor data
      const invRes = await fetch(`${SUPABASE_URL}/rest/v1/investors?id=eq.${payload.id}&select=*`, { headers });
      const invData = await invRes.json();
      if (!invData.length) return new Response(JSON.stringify({ valid: false }), { status: 401, headers: cors });
      return new Response(JSON.stringify({ valid: true, investor: safeInvestor(invData[0]) }), { status: 200, headers: cors });
    }

    if (action === 'reset_request') {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 3600000).toISOString(); // 1 hour
      await fetch(`${SUPABASE_URL}/rest/v1/investors?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ reset_token: token, reset_token_expires: expires }),
      });
      // In production: send email with reset link. For now return token for testing.
      return new Response(JSON.stringify({ success: true, message: 'If an account exists, a reset link has been sent.' }), { status: 200, headers: cors });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: cors });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error', message: err.message }), { status: 500, headers: cors });
  }
};

function generateToken(id, email, plan, secret) {
  const payload = { id, email, plan, iat: Date.now(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }; // 7 days
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(data).digest('hex');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function safeInvestor(inv) {
  return { id: inv.id, email: inv.email, name: inv.name, plan: inv.plan, analyses_this_month: inv.analyses_this_month, stripe_customer_id: inv.stripe_customer_id, created_at: inv.created_at };
}
