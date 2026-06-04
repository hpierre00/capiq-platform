/**
 * Netlify Function: realtor-checkout
 *
 * Handles Stripe checkout and billing portal for the Realtor portal.
 * POST body: { action, token, successUrl, cancelUrl, returnUrl }
 *   action: 'create_checkout' | 'create_portal'
 * Returns: { checkoutUrl } | { portalUrl } | { error }
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY    — Stripe live secret key
 *   REALTOR_PRICE_ID     — Stripe price ID for $49/month realtor plan
 *   SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_KEY — Supabase service role key
 *   SITE_URL             — Base site URL (e.g. https://underlytix.com)
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL        = process.env.SUPABASE_URL || 'https://mxyepucitjzleaziizkr.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
// Fallback payment link if no price ID configured
const FALLBACK_PAYMENT_LINK = 'https://buy.stripe.com/realtor-placeholder';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action, token, successUrl, cancelUrl, returnUrl } = body;

  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };
  }

  // Verify token and get user email
  let userEmail = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    if (res.ok) { const u = await res.json(); userEmail = u.email; }
  } catch (err) {
    console.error('[realtor-checkout] Supabase error:', err.message);
  }

  const siteUrl = process.env.SITE_URL || 'https://underlytix.com';

  try {
    if (action === 'create_portal') {
      // Find Stripe customer and open billing portal
      const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
      if (!customers.data.length) {
        return { statusCode: 404, body: JSON.stringify({ error: 'No billing account found. Please subscribe first.' }) };
      }
      const session = await stripe.billingPortal.sessions.create({
        customer: customers.data[0].id,
        return_url: returnUrl || `${siteUrl}/realtor`,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portalUrl: session.url }),
      };
    }

    // Default: create_checkout
    const priceId = process.env.REALTOR_PRICE_ID;
    if (!priceId) {
      // No price configured — redirect to payment link fallback
      const fallback = `${siteUrl}/checkout?plan=realtor${userEmail ? '&email=' + encodeURIComponent(userEmail) : ''}`;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkoutUrl: fallback }),
      };
    }

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${siteUrl}/realtor?realtor_upgraded=true`,
      cancel_url:  cancelUrl  || `${siteUrl}/realtor`,
      allow_promotion_codes: true,
    };

    if (userEmail) sessionParams.customer_email = userEmail;

    const session = await stripe.checkout.sessions.create(sessionParams);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutUrl: session.url }),
    };
  } catch (err) {
    console.error('[realtor-checkout] Stripe error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Checkout unavailable' }) };
  }
};
