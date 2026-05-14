// Stripe webhook receiver - forwards events to Supabase to update investor plans
export default async (req) => {
  const cors = { 'Content-Type': 'application/json' };
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });

  try {
    const body = await req.text();
    const WEBHOOK_SECRET = Netlify.env.get('STRIPE_WEBHOOK_SECRET') || '';
    
    // Verify Stripe signature if secret is configured
    if (WEBHOOK_SECRET) {
      const sig = req.headers.get('stripe-signature');
      if (!sig) return new Response(JSON.stringify({ error: 'Missing signature' }), { status: 400, headers: cors });
      
      // Stripe signature verification
      const parts = sig.split(',').reduce((acc, part) => {
        const [k, v] = part.split('=');
        acc[k] = v;
        return acc;
      }, {});
      const timestamp = parts.t;
      const sigHash = parts.v1;
      const payload = `${timestamp}.${body}`;
      
      // HMAC-SHA256 verification
      const encoder = new TextEncoder();
      const keyData = encoder.encode(WEBHOOK_SECRET);
      const msgData = encoder.encode(payload);
      const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      const sigBytes = new Uint8Array(sigHash.match(/.{2}/g).map(b => parseInt(b, 16)));
      const valid = await crypto.subtle.verify('HMAC', cryptoKey, sigBytes, msgData);
      
      if (!valid) return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400, headers: cors });
      
      // Check timestamp not older than 5 minutes
      const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
      if (age > 300) return new Response(JSON.stringify({ error: 'Webhook timestamp too old' }), { status: 400, headers: cors });
    }
    
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

    // Handle lender subscription events
    const lenderUserId = meta.lender_user_id;
    if ((type === 'checkout.session.completed' || type === 'invoice.payment_succeeded') && lenderUserId) {
      // Upgrade lender plan in Supabase
      const lenderLookup = await fetch(`${SUPABASE_URL}/rest/v1/lender_users?id=eq.${lenderUserId}&select=id,email,full_name,lender_profiles(lender_name)`, { headers });
      const lenderRows = await lenderLookup.json();
      if (lenderRows.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/lender_users?id=eq.${lenderUserId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ plan: 'active', stripe_customer_id: customerId, stripe_subscription_id: obj.subscription || obj.id }),
        });
        const lenderRow = lenderRows[0];
        // Fire Notion CRM sync — mark as Closed Won
        const baseUrl = 'https://underlytix.com';
        fetch(`${baseUrl}/.netlify/functions/notion-lender-sync`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'lender_closed',
            lender: { email: lenderRow.email, name: lenderRow.full_name, companyName: lenderRow.lender_profiles?.lender_name, planAmount: 297 }
          }),
        }).catch(() => {});
        console.log(`Upgraded lender ${lenderUserId} to active`);
      }
    }

    // Handle realtor subscription events
    const realtorId = meta.realtor_id;
    if ((type === 'checkout.session.completed' || type === 'invoice.payment_succeeded') && realtorId) {
      await fetch(`${SUPABASE_URL}/rest/v1/realtor_users?id=eq.${realtorId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ plan: 'active', stripe_customer_id: customerId }),
      });
      // Fire upgrade confirmation email
      const rLookup = await fetch(`${SUPABASE_URL}/rest/v1/realtor_users?id=eq.${realtorId}&select=email,full_name`, { headers });
      const rRows = await rLookup.json();
      if (rRows.length > 0) {
        const RESEND_KEY = process.env.RESEND_API_KEY || '';
        if (RESEND_KEY) {
          fetch('https://api.resend.com/emails', {
            method: 'POST', headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Underlytix <noreply@underlytix.com>', to: [rRows[0].email],
              subject: 'Underlytix Realtor Pro — Activated',
              html: `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:40px"><div style="font-size:20px;font-weight:800;color:#0a1628;margin-bottom:24px">UNDERLYTIX</div><h1 style="font-size:22px;color:#0a1628">You're on Realtor Pro, ${rRows[0].full_name || 'there'}.</h1><p style="color:#374151;font-size:15px;line-height:1.6">Unlimited client prequalifications are now active. Available Friday at midnight, Saturday at 8pm, all day Sunday — always.</p><a href="https://underlytix.com" style="display:inline-block;background:#00bfa5;color:#fff;font-weight:600;padding:14px 28px;border-radius:8px;text-decoration:none;margin:16px 0">Open Realtor Portal →</a></div>`,
            }),
          }).catch(() => {});
        }
        console.log(`Upgraded realtor ${realtorId} to active`);
      }
    }

    // Handle realtor subscription cancellation
    if (type === 'customer.subscription.deleted' && customerId) {
      const rLookup = await fetch(`${SUPABASE_URL}/rest/v1/realtor_users?stripe_customer_id=eq.${customerId}&select=id`, { headers });
      const rRows = await rLookup.json();
      if (rRows.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/realtor_users?id=eq.${rRows[0].id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ plan: 'cancelled' }),
        });
      }
    }

    // Handle lender subscription cancellation
    if ((type === 'customer.subscription.deleted') && customerId) {
      const lenderLookup = await fetch(`${SUPABASE_URL}/rest/v1/lender_users?stripe_customer_id=eq.${customerId}&select=id`, { headers });
      const lenderRows = await lenderLookup.json();
      if (lenderRows.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/lender_users?id=eq.${lenderRows[0].id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ plan: 'cancelled' }),
        });
        console.log(`Cancelled lender ${lenderRows[0].id}`);
      }
    }

    return new Response(JSON.stringify({ received: true }), { status: 200, headers: cors });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: cors }); // Always 200 to Stripe
  }
};
