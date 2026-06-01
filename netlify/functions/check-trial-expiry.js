/**
 * Netlify Scheduled Function: check-trial-expiry
 *
 * Runs daily. Finds realtors whose trial expired today and fires the
 * winback sequence webhook in Make.com.
 *
 * Deploy to: netlify/functions/check-trial-expiry.js
 *
 * Add to netlify.toml:
 *   [[plugins]]
 *   package = "@netlify/plugin-nextjs"
 *
 *   [functions."check-trial-expiry"]
 *   schedule = "0 10 * * *"   # runs at 10am UTC daily
 *
 * Required environment variables:
 *   SUPABASE_URL              — e.g. https://mxyepucitjzleaziizkr.supabase.co
 *   SUPABASE_SERVICE_KEY      — service_role key (NOT anon key)
 *   MAKE_WEBHOOK_TRIAL_EXPIRED
 *   TRIGGER_SECRET
 */

exports.handler = async () => {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, MAKE_WEBHOOK_TRIAL_EXPIRED } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !MAKE_WEBHOOK_TRIAL_EXPIRED) {
    console.error('[check-trial-expiry] Missing env vars');
    return { statusCode: 500 };
  }

  // Query realtors whose trial expired in the last 24 hours and have not paid
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/realtors?trial_ends_at=gte.${yesterday}&trial_ends_at=lte.${now}&plan=eq.trial&select=email,full_name,trial_ends_at`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    console.error('[check-trial-expiry] Supabase query failed:', res.status);
    return { statusCode: 502 };
  }

  const realtors = await res.json();
  console.log(`[check-trial-expiry] Found ${realtors.length} expired trials`);

  // Fire Make.com webhook for each
  await Promise.allSettled(
    realtors.map((r) =>
      fetch(MAKE_WEBHOOK_TRIAL_EXPIRED, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: r.email, name: r.full_name }),
      })
    )
  );

  return { statusCode: 200, body: JSON.stringify({ fired: realtors.length }) };
};
