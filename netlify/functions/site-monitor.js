/**
 * Netlify Scheduled Function: site-monitor
 *
 * Runs every hour. Checks all critical Underlytix endpoints and
 * Supabase connectivity. Sends an alert email via Resend when any
 * check fails, including diagnostic details and suggested fixes.
 *
 * Schedule configured in netlify.toml:
 *   [functions."site-monitor"]
 *     schedule = "0 * * * *"
 *
 * Required env vars:
 *   SITE_URL         — https://underlytix.com
 *   SUPABASE_URL     — https://mxyepucitjzleaziizkr.supabase.co
 *   SUPABASE_SERVICE_KEY
 *   RESEND_API_KEY   — for email alerts
 *   MONITOR_ALERT_TO — email address to alert (defaults to hpierre00@gmail.com)
 */

const SITE_URL      = process.env.SITE_URL           || 'https://underlytix.com';
const SUPABASE_URL  = process.env.SUPABASE_URL        || 'https://mxyepucitjzleaziizkr.supabase.co';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const ALERT_TO      = process.env.MONITOR_ALERT_TO   || 'hpierre00@gmail.com';
const FROM_EMAIL    = process.env.RESEND_FROM_EMAIL  || 'Underlytix Monitor <noreply@underlytix.com>';

const TIMEOUT_MS    = 8000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

async function checkEndpoint({ name, url, method = 'GET', body, expectStatus = 200, expectField }) {
  const start = Date.now();
  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await withTimeout(fetch(url, opts), TIMEOUT_MS);
    const latency = Date.now() - start;

    // Some endpoints return 400/401/403 on test calls — that still means they're up
    const up = res.status < 500;

    let detail = `HTTP ${res.status}`;
    if (expectField) {
      try {
        const json = await res.json();
        if (!(expectField in json)) {
          return { name, ok: false, latency, detail: `Missing field "${expectField}" in response` };
        }
        detail += ` — field "${expectField}" present`;
      } catch {
        // non-JSON response is fine unless we were explicitly checking a field
        if (expectStatus === 200) {
          return { name, ok: false, latency, detail: 'Expected JSON but got non-JSON response' };
        }
      }
    }

    if (res.status !== expectStatus && !up) {
      return { name, ok: false, latency, detail: `Expected ${expectStatus}, got ${res.status}` };
    }

    return { name, ok: up, latency, detail };
  } catch (e) {
    return { name, ok: false, latency: Date.now() - start, detail: e.message };
  }
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function runChecks() {
  const results = await Promise.all([

    // 1. Realtor portal page loads
    checkEndpoint({ name: 'Realtor Portal (HTML)', url: `${SITE_URL}/realtor.html`, expectStatus: 200 }),

    // 2. Admin portal page loads
    checkEndpoint({ name: 'Admin Portal (HTML)', url: `${SITE_URL}/admin.html`, expectStatus: 200 }),

    // 3. Lender portal page loads
    checkEndpoint({ name: 'Lender Portal (HTML)', url: `${SITE_URL}/lender.html`, expectStatus: 200 }),

    // 4. Investor portal page loads
    checkEndpoint({ name: 'Investor Portal (HTML)', url: `${SITE_URL}/investor.html`, expectStatus: 200 }),

    // 5. realtor-prequal function responds (401 = up, just unauthorized)
    checkEndpoint({
      name: 'Function: realtor-prequal',
      url:  `${SITE_URL}/.netlify/functions/realtor-prequal`,
      method: 'POST',
      body:   { action: 'ping' },
      expectStatus: 400, // will 400 on bad input — means function is running
    }),

    // 6. realtor-tts function responds
    checkEndpoint({
      name: 'Function: realtor-tts',
      url:  `${SITE_URL}/.netlify/functions/realtor-tts`,
      method: 'POST',
      body:   { text: '' },
      expectStatus: 400,
    }),

    // 7. admin-invite function responds
    checkEndpoint({
      name: 'Function: admin-invite',
      url:  `${SITE_URL}/.netlify/functions/admin-invite`,
      method: 'POST',
      body:   {},
      expectStatus: 400,
    }),

    // 8. admin-manage function responds
    checkEndpoint({
      name: 'Function: admin-manage',
      url:  `${SITE_URL}/.netlify/functions/admin-manage`,
      method: 'POST',
      body:   {},
      expectStatus: 400,
    }),

    // 9. Supabase REST API responds
    checkEndpoint({
      name: 'Supabase REST',
      url:  `${SUPABASE_URL}/rest/v1/`,
      expectStatus: 200,
    }),

    // 10. Supabase Auth responds
    checkEndpoint({
      name: 'Supabase Auth',
      url:  `${SUPABASE_URL}/auth/v1/health`,
      expectStatus: 200,
    }),
  ]);

  return results;
}

// ── Alert ─────────────────────────────────────────────────────────────────────

async function sendAlert(failures, allResults) {
  if (!RESEND_KEY) {
    console.error('[site-monitor] RESEND_API_KEY not set — cannot send alert email');
    console.error('[site-monitor] Failures:', failures.map(f => f.name).join(', '));
    return false;
  }

  const timestamp = new Date().toUTCString();
  const failRows  = failures.map(f =>
    `<tr style="background:#fef2f2">
      <td style="padding:8px 12px;border-bottom:1px solid #fecaca;font-weight:600;color:#991b1b">${f.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #fecaca;color:#dc2626">✗ DOWN</td>
      <td style="padding:8px 12px;border-bottom:1px solid #fecaca;color:#64748b">${f.latency}ms</td>
      <td style="padding:8px 12px;border-bottom:1px solid #fecaca;color:#64748b;font-family:monospace;font-size:12px">${f.detail}</td>
    </tr>`
  ).join('');

  const passRows = allResults.filter(r => r.ok).map(r =>
    `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;color:#374151">${r.name}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;color:#059669">✓ UP</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;color:#64748b">${r.latency}ms</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;color:#64748b"></td>
    </tr>`
  ).join('');

  const suggestions = failures.map(f => {
    if (f.name.includes('Supabase'))     return `<li>Check Supabase project status at <a href="https://supabase.com/dashboard/project/mxyepucitjzleaziizkr">dashboard</a></li>`;
    if (f.name.includes('realtor-tts'))  return `<li>Verify <code>ELEVENLABS_API_KEY</code> is set in Netlify env vars</li>`;
    if (f.name.includes('realtor-prequal')) return `<li>Verify <code>ANTHROPIC_API_KEY</code> is set and valid</li>`;
    if (f.name.includes('HTML'))         return `<li>Page ${f.name} is returning an error — check Netlify deploy status</li>`;
    return `<li>${f.name} is down (${f.detail}) — check Netlify function logs</li>`;
  }).join('');

  const html = `
<div style="font-family:sans-serif;max-width:660px;margin:0 auto;color:#0f172a">
  <div style="background:#0f172a;padding:20px 24px;border-radius:8px 8px 0 0">
    <div style="color:#f6ad55;font-weight:700;font-size:16px">⚠ Underlytix Site Alert</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:4px">${timestamp}</div>
  </div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:24px;border-radius:0 0 8px 8px">
    <p style="margin:0 0 16px;font-size:14px">
      <strong>${failures.length} check${failures.length > 1 ? 's' : ''} failed</strong> out of ${allResults.length} total.
    </p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0;color:#374151">Check</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0;color:#374151">Status</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0;color:#374151">Latency</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0;color:#374151">Detail</th>
        </tr>
      </thead>
      <tbody>${failRows}${passRows}</tbody>
    </table>
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:16px;margin-bottom:16px">
      <div style="font-weight:600;font-size:13px;color:#92400e;margin-bottom:8px">Suggested actions:</div>
      <ul style="margin:0;padding-left:20px;font-size:13px;color:#78350f;line-height:1.8">${suggestions}</ul>
    </div>
    <a href="https://app.netlify.com/projects/capiq-platform"
       style="background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;display:inline-block">
      Open Netlify Dashboard →
    </a>
  </div>
</div>`;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      from:    FROM_EMAIL,
      to:      ALERT_TO,
      subject: `[Underlytix Alert] ${failures.length} service${failures.length > 1 ? 's' : ''} down — ${timestamp}`,
      html,
    }),
  }).catch(err => { console.error('[site-monitor] Resend failed:', err.message); return null; });

  return emailRes?.ok === true;
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log('[site-monitor] Starting health checks at', new Date().toISOString());

  const results  = await runChecks();
  const failures = results.filter(r => !r.ok);

  console.log('[site-monitor] Results:');
  results.forEach(r => console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} — ${r.latency}ms — ${r.detail}`));

  if (failures.length > 0) {
    console.warn(`[site-monitor] ${failures.length} failure(s) detected`);
    const sent = await sendAlert(failures, results);
    console.log('[site-monitor] Alert email sent:', sent);
  } else {
    console.log('[site-monitor] All checks passed ✓');
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok:       failures.length === 0,
      checked:  results.length,
      failures: failures.length,
      results:  results.map(r => ({ name: r.name, ok: r.ok, latency: r.latency, detail: r.detail })),
      timestamp: new Date().toISOString(),
    }),
  };
};
