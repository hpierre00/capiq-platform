export default async (req) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const SUPABASE_URL = 'https://mxyepucitjzleaziizkr.supabase.co';
    const SVC_KEY = Netlify.env.get('SUPABASE_SERVICE_KEY') || '';
    const [prequalRes, lenderRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/client_prequals?select=count`, {
        headers: { 'apikey': SVC_KEY, 'Authorization': `Bearer ${SVC_KEY}`, 'Prefer': 'count=exact', 'Range': '0-0' }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/lender_profiles?select=count&active_status=eq.true`, {
        headers: { 'apikey': SVC_KEY, 'Authorization': `Bearer ${SVC_KEY}`, 'Prefer': 'count=exact', 'Range': '0-0' }
      })
    ]);
    const scenarios = parseInt(prequalRes.headers.get('content-range')?.split('/')[1] || '0');
    const lenders = parseInt(lenderRes.headers.get('content-range')?.split('/')[1] || '0');
    // Add base numbers so counter never shows zero at launch
    return new Response(JSON.stringify({ scenarios: scenarios + 47, lenders: lenders + 12 }), { headers: cors });
  } catch(e) {
    return new Response(JSON.stringify({ scenarios: 47, lenders: 12 }), { headers: cors });
  }
};
