/**
 * Netlify Function: lender-qm-addon-checkout
 *
 * Creates a Stripe Checkout session for the lender QM addon (+$99/mo).
 * Called by lender.html lenderStartQMAddonCheckout().
 *
 * POST body: { token, successUrl, cancelUrl }
 * Returns:   { checkoutUrl } or { error }
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mxyepucitjzleaziizkr.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
// Pinned to acct_1TQUoT — correct Netlify Stripe account
const LENDER_QM_PRICE_ID = 'price_1TdOFEBdTWAzjDqG9e6ynNun';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { token, successUrl, cancelUrl } = body;

  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };
  }

  // Verify token and get user email from Supabase
  let userEmail = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (res.ok) {
      const user = await res.json();
      userEmail = user.email;
    }
  } catch (err) {
    console.error('[lender-qm-addon-checkout] Supabase verify error:', err.message);
  }

  try {
    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: LENDER_QM_PRICE_ID, quantity: 1 }],
      success_url: successUrl || `${process.env.SITE_URL}/lender?qm_upgraded=true`,
      cancel_url: cancelUrl || `${process.env.SITE_URL}/lender`,
      allow_promotion_codes: true,
    };

    if (userEmail) {
      sessionParams.customer_email = userEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutUrl: session.url }),
    };
  } catch (err) {
    console.error('[lender-qm-addon-checkout] Stripe error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Checkout unavailable' }),
    };
  }
};
