/**
 * Netlify Function: trigger-sequence
 *
 * Fires Make.com webhooks to enroll a subscriber in the correct email sequence.
 * Called by the frontend on signup, and by a cron job on trial expiry.
 *
 * Deploy to: netlify/functions/trigger-sequence.js
 *
 * Required environment variables:
 *   MAKE_WEBHOOK_TRIAL_SIGNUP   — fires Sequence 2 (trial onboarding)
 *   MAKE_WEBHOOK_TRIAL_EXPIRED  — fires Sequence 3 (winback)
 *   MAKE_WEBHOOK_PAID           — exits all sequences for a paid subscriber
 *   TRIGGER_SECRET              — shared secret to prevent abuse (set same in Netlify env)
 */

const WEBHOOKS = {
  trial_signup:  process.env.MAKE_WEBHOOK_TRIAL_SIGNUP,
  trial_expired: process.env.MAKE_WEBHOOK_TRIAL_EXPIRED,
  paid:          process.env.MAKE_WEBHOOK_PAID,
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Basic secret check — set TRIGGER_SECRET in Netlify environment
  const authHeader = event.headers['x-trigger-secret'] || '';
  if (process.env.TRIGGER_SECRET && authHeader !== process.env.TRIGGER_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { event: sequenceEvent, email, name, trial_ends_at } = body;

  if (!sequenceEvent || !email) {
    return { statusCode: 400, body: 'Missing required fields: event, email' };
  }

  const webhookUrl = WEBHOOKS[sequenceEvent];
  if (!webhookUrl) {
    return { statusCode: 400, body: `Unknown event type: ${sequenceEvent}. Use: trial_signup, trial_expired, paid` };
  }

  try {
    const payload = { email, name: name || '', trial_ends_at: trial_ends_at || null };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`Make.com webhook failed: ${response.status} ${await response.text()}`);
      return { statusCode: 502, body: 'Failed to notify Make.com' };
    }

    console.log(`[trigger-sequence] ${sequenceEvent} fired for ${email}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, event: sequenceEvent, email }) };

  } catch (err) {
    console.error('[trigger-sequence] error:', err);
    return { statusCode: 500, body: 'Internal server error' };
  }
};
