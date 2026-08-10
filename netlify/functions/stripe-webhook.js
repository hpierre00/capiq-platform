/**
 * Netlify Function: stripe-webhook
 *
 * Listens for Stripe subscription events and syncs access status to Supabase.
 * Register this endpoint in Stripe Dashboard → Developers → Webhooks.
 *
 * Endpoint URL: https://underlytix.com/.netlify/functions/stripe-webhook
 *
 * Events to enable in Stripe:
 *   - customer.subscription.created
 *   - customer.subscription.updated
 *   - customer.subscription.deleted
 *   - invoice.payment_succeeded
 *   - invoice.payment_failed
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY         — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET     — Webhook signing secret (from Stripe Dashboard)
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_KEY      — Supabase service role key
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL        = process.env.SUPABASE_URL || 'https://mxyepucitjzleaziizkr.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET      = process.env.STRIPE_WEBHOOK_SECRET;

// Price IDs → user role mapping
const PRICE_ROLE_MAP = {
  [process.env.LENDER_PRICE_ID       || 'price_1TdOFDBdTWAzjDqGJ1YpeviL']: 'lender',
  [process.env.LENDER_QM_PRICE_ID    || 'price_1TdOFEBdTWAzjDqG9e6ynNun']: 'lender',
};

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} → ${res.status}`);
  return res.json();
}

async function supabasePatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase PATCH ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Find user by email via Supabase Admin API ─────────────────────────────────

async function getUserByEmail(email) {
  const data = await supabaseGet(`/auth/v1/admin/users?email=${encodeURIComponent(email)}`);
  return data?.users?.[0] || null;
}

// ── Determine role from subscription ──────────────────────────────────────────

function getRoleFromSubscription(subscription) {
  for (const item of subscription.items?.data || []) {
    const priceId = item.price?.id;
    if (PRICE_ROLE_MAP[priceId]) return PRICE_ROLE_MAP[priceId];
  }
  // Default to 'realtor' for any unrecognized paid subscription
  return 'realtor';
}

// ── Update user metadata in Supabase ─────────────────────────────────────────

async function updateUserSubscription(userId, updates) {
  return supabasePatch(`/auth/v1/admin/users/${userId}`, {
    user_metadata: updates,
  });
}

// ── Handle each event type ────────────────────────────────────────────────────

async function handleSubscriptionCreatedOrUpdated(subscription) {
  const customerId = subscription.customer;
  const customer   = await stripe.customers.retrieve(customerId);
  const email      = customer.email;

  if (!email) {
    console.log('[stripe-webhook] No email on customer', customerId);
    return;
  }

  const user = await getUserByEmail(email);
  if (!user) {
    console.log('[stripe-webhook] No Supabase user for email', email);
    return;
  }

  const role   = getRoleFromSubscription(subscription);
  const status = subscription.status; // active, trialing, past_due, canceled, etc.
  const isPaid = ['active', 'trialing'].includes(status);

  await updateUserSubscription(user.id, {
    subscription_status:    status,
    subscription_id:        subscription.id,
    subscription_role:      role,
    subscription_paid:      isPaid,
    stripe_customer_id:     customerId,
    subscription_updated_at: new Date().toISOString(),
  });

  console.log(`[stripe-webhook] Updated user ${email} → role:${role} status:${status}`);
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  const customer   = await stripe.customers.retrieve(customerId);
  const email      = customer.email;

  if (!email) return;

  const user = await getUserByEmail(email);
  if (!user) return;

  await updateUserSubscription(user.id, {
    subscription_status:     'canceled',
    subscription_paid:       false,
    subscription_updated_at: new Date().toISOString(),
  });

  console.log(`[stripe-webhook] Canceled subscription for ${email}`);
}

async function handlePaymentFailed(invoice) {
  const customerId = invoice.customer;
  const customer   = await stripe.customers.retrieve(customerId);
  const email      = customer.email;

  if (!email) return;

  const user = await getUserByEmail(email);
  if (!user) return;

  await updateUserSubscription(user.id, {
    subscription_status:     'past_due',
    subscription_paid:       false,
    subscription_updated_at: new Date().toISOString(),
  });

  console.log(`[stripe-webhook] Payment failed for ${email}`);
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Verify Stripe signature
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      event.headers['stripe-signature'],
      WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log(`[stripe-webhook] Received: ${stripeEvent.type}`);

  try {
    switch (stripeEvent.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionCreatedOrUpdated(stripeEvent.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;

      case 'invoice.payment_succeeded':
        // Subscription updated event covers this, but log it
        console.log('[stripe-webhook] Payment succeeded for invoice', stripeEvent.data.object.id);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(stripeEvent.data.object);
        break;

      default:
        console.log(`[stripe-webhook] Unhandled event: ${stripeEvent.type}`);
    }
  } catch (err) {
    console.error('[stripe-webhook] Handler error:', err.message);
    return { statusCode: 500, body: 'Internal error processing webhook' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
