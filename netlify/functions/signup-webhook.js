/**
 * Netlify Function: signup-webhook
 *
 * Routes new signups to the correct Make.com scenario webhook.
 * Called by investor.html (and optionally realtor.html) on successful signup.
 *
 * POST body: { userType, email, name, plan }
 * Returns:   { ok: true } or { error }
 *
 * Webhook URLs (active scenarios as of 2026-06-01):
 *   realtor  → scenario 5253824 → MAKE_WEBHOOK_REALTOR_SIGNUP env var
 *   investor → scenario 5253830 → MAKE_WEBHOOK_INVESTOR_SIGNUP env var
 */

const WEBHOOK_URLS = {
  realtor:  process.env.MAKE_WEBHOOK_REALTOR_SIGNUP,
  investor: process.env.MAKE_WEBHOOK_INVESTOR_SIGNUP,
};

const TRIAL_DAYS = 14;

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

  const { userType, email, name, plan } = body;

  if (!userType || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: userType, email' }) };
  }

  const webhookUrl = WEBHOOK_URLS[userType];
  if (!webhookUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Unknown userType: ${userType}. Use: realtor, investor` }),
    };
  }

  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const payload = {
      email,
      name:          name || '',
      userType,
      plan:          plan || 'starter',
      trial_ends_at: trialEndsAt,
    };

    const response = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[signup-webhook] Make.com rejected ${userType} signup for ${email}: ${response.status}`);
      return { statusCode: 502, body: JSON.stringify({ error: 'Failed to notify Make.com' }) };
    }

    console.log(`[signup-webhook] ${userType} signup fired for ${email}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, userType, email }),
    };
  } catch (err) {
    console.error('[signup-webhook] error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
