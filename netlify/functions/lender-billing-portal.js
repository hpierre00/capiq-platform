/**
 * Netlify Function: lender-billing-portal
 * Creates a Stripe Customer Portal session for existing lender subscribers.
 * POST body: { token, returnUrl }
 * Returns: { portalUrl } or { error }
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mxyepucitjzleaziizkr.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { token, returnUrl } = body;
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };

  // Get user email from Supabase
  let userEmail = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    if (res.ok) { const u = await res.json(); userEmail = u.email; }
  } catch (err) {
    console.error('[lender-billing-portal] Supabase error:', err.message);
  }

  if (!userEmail) return { statusCode: 401, body: JSON.stringify({ error: 'User not found' }) };

  try {
    // Find Stripe customer by email
    const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
    if (!customers.data.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No billing account found. Please subscribe first.' }) };
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: returnUrl || `${process.env.SITE_URL}/lender`,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portalUrl: session.url }),
    };
  } catch (err) {
    console.error('[lender-billing-portal] Stripe error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Billing portal unavailable' }) };
  }
};
