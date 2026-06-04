/**
 * Netlify Function: lender-checkout
 * Creates a Stripe Checkout session for the lender base subscription ($297/mo).
 * POST body: { token, email, successUrl, cancelUrl }
 * Returns:   { checkoutUrl } or { error }
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL         = process.env.SUPABASE_URL || 'https://mxyepucitjzleaziizkr.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Pinned to acct_1TQUoT — correct Netlify Stripe account (do NOT use env var override)
const LENDER_PRICE_ID = 'price_1TdOFDBdTWAzjDqGJ1YpeviL';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { token, successUrl, cancelUrl } = body;

  // Allow unauthenticated requests (from /checkout page) — use provided email for pre-fill
  let userEmail = body.email || null;

  if (token) {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
      });
      if (res.ok) { const user = await res.json(); userEmail = user.email || userEmail; }
    } catch (err) {
      console.error('[lender-checkout] Supabase verify error:', err.message);
    }
  }

  try {
    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: LENDER_PRICE_ID, quantity: 1 }],
      success_url: successUrl || `${process.env.SITE_URL}/lender?lender_upgraded=true`,
      cancel_url:  cancelUrl  || `${process.env.SITE_URL}/lender`,
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
    console.error('[lender-checkout] Stripe error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Checkout unavailable' }),
    };
  }
};
