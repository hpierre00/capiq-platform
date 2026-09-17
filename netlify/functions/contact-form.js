/**
 * Netlify Function: contact-form
 *
 * Receives the site-wide "Help & Support" widget's contact form and emails
 * the submission via Resend. Mirrors the fetch-based Resend pattern already
 * used in site-monitor.js and admin-invite.js — no new dependency added.
 *
 * POST body: { name, email, topic, message, company }
 *   - company: honeypot field. Real visitors never see or fill it (it's
 *     visually hidden off-screen, not display:none, so basic bots that skip
 *     display:none fields still get caught). If it arrives non-empty, the
 *     request is silently accepted (200) without sending mail.
 *
 * Returns: { ok: true } or { error: '...' }
 *
 * Env vars (all optional — sane defaults match the rest of this site):
 *   RESEND_API_KEY      — already set in Netlify (used by site-monitor.js / admin-invite.js)
 *   CONTACT_FROM_EMAIL  — default 'Underlytix Support <support@underlytix.com>'
 *   CONTACT_ALERT_TO    — default 'hpierre00@gmail.com'
 */

const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.CONTACT_FROM_EMAIL || 'Underlytix Support <support@underlytix.com>';
const ALERT_TO     = process.env.CONTACT_ALERT_TO   || 'hpierre00@gmail.com';

const VALID_TOPICS = ['general', 'investor', 'realtor', 'lender', 'billing'];
const MAX_MESSAGE_LEN = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

  const { name, email, message } = body;
  const company = body.company || ''; // honeypot
  let topic = (body.topic || 'general').toLowerCase();

  // Honeypot tripped — pretend success, send nothing.
  if (company.trim() !== '') {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (!name || !email || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: name, email, message' }) };
  }
  if (!EMAIL_RE.test(String(email).trim())) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email address' }) };
  }
  if (String(message).length > MAX_MESSAGE_LEN) {
    return { statusCode: 400, body: JSON.stringify({ error: `Message too long (max ${MAX_MESSAGE_LEN} characters)` }) };
  }
  if (!VALID_TOPICS.includes(topic)) {
    topic = 'general';
  }

  if (!RESEND_KEY) {
    console.error('[contact-form] RESEND_API_KEY not configured');
    return { statusCode: 500, body: JSON.stringify({ error: 'Email service not configured' }) };
  }

  const safeName    = escapeHtml(name).slice(0, 200);
  const safeEmail   = escapeHtml(email).trim().slice(0, 200);
  const safeMessage = escapeHtml(message);
  const topicLabel  = topic.charAt(0).toUpperCase() + topic.slice(1);

  const html = `
    <h2 style="font-family:sans-serif;color:#0f2240">New contact form submission</h2>
    <table style="font-family:sans-serif;font-size:14px;color:#0f172a;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#64748b">Name</td><td>${safeName}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#64748b">Email</td><td>${safeEmail}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#64748b">Topic</td><td>${escapeHtml(topicLabel)}</td></tr>
    </table>
    <p style="font-family:sans-serif;font-size:14px;color:#0f172a;white-space:pre-wrap;margin-top:16px;border-top:1px solid #e2e8f0;padding-top:16px">${safeMessage}</p>
  `;

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from:     FROM_EMAIL,
        to:       ALERT_TO,
        reply_to: email,
        subject:  `[Underlytix Contact] ${topicLabel} — ${name}`,
        html,
      }),
    }).catch(err => { console.error('[contact-form] Resend request failed:', err.message); return null; });

    if (!emailRes || !emailRes.ok) {
      const detail = emailRes ? await emailRes.text().catch(() => '') : 'network error';
      console.error('[contact-form] Resend send failed:', detail);
      return { statusCode: 502, body: JSON.stringify({ error: 'Failed to send message. Please try again or email support@underlytix.com directly.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[contact-form] Unexpected error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Unexpected error sending message' }) };
  }
};
