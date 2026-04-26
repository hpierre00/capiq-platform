// Stripe webhook receiver - forwards events to Supabase to update investor plans
export default async (req) => {
  const cors = { 'Content-Type': 'application/json' };
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });

  try {
    const body = await req.text();
    const event = JSON.parse(body);
    const type = event.type;
    const obj = event.data?.object || {};

    const SUPABASE_URL = 'https://mxyepucitjzleaziizkr.supabase.co';
    const SUPABASE_KEY = Netlify.env.get('SUPABASE_SERVICE_KEY') || '';

    if (!SUPABASE_KEY) {
      console.warn('SUPABASE_SERVICE_KEY not set');
      return new Response(JSON.stringify({ received: true }), { status: 200, headers: cors });
    }

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal',
    };

    // Extract investor ID from metadata
    const meta = obj.metadata || {};
    const investorId = meta.investor_id || obj.client_reference_id;
    const customerId = obj.customer;

    if ((type === 'checkout.session.completed' || type === 'invoice.payment_succeeded') && (investorId || customerId)) {
      let targetId = investorId;

      // If we only have customer ID, look up investor
      if (!targetId && customerId) {
        const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/investors?stripe_customer_id=eq.${customerId}&select=id`, { headers });
        const investors = await lookupRes.json();
        if (investors.length > 0) targetId = investors[0].id;
      }

      if (targetId) {
        await fetch(`${SUPABASE_URL}/rest/v1/investors?id=eq.${targetId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({
            plan: 'pro',
            stripe_customer_id: customerId,
            stripe_subscription_id: obj.subscription || obj.id,
            updated_at: new Date().toISOString(),
          }),
        });

        // Upsert subscription record
        await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({
            stripe_subscription_id: obj.subscription || obj.id,
            stripe_customer_id: customerId,
            user_type: 'investor',
            user_id: targetId,
            plan: 'pro',
            status: 'active',
            current_period_start: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        });
        console.log(`Upgraded investor ${targetId} to pro`);
      }
    }

    if ((type === 'customer.subscription.deleted' || type === 'customer.subscription.paused') && customerId) {
      const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/investors?stripe_customer_id=eq.${customerId}&select=id`, { headers });
      const investors = await lookupRes.json();
      if (investors.length > 0) {
        const targetId = investors[0].id;
        await fetch(`${SUPABASE_URL}/rest/v1/investors?id=eq.${targetId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ plan: 'starter', updated_at: new Date().toISOString() }),
        });
        console.log(`Downgraded investor ${targetId} to starter`);
      }
    }

    return new Response(JSON.stringify({ received: true }), { status: 200, headers: cors });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: cors }); // Always 200 to Stripe
  }
};
