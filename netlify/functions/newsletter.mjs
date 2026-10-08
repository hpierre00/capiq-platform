// Newsletter signup with double opt-in (Resend).
//   POST  -> emails a signed confirmation link; adds nobody yet.
//   GET   -> verifies the signed link, then adds the contact to the segment and topic.
// Required env var: SIGNUP_SECRET (long random string). RESEND_API_KEY is already set on this site.
// Optional overrides: NEWSLETTER_FROM_EMAIL, NEWSLETTER_REPLY_TO.
import { createHmac, timingSafeEqual } from "node:crypto";

const CFG = {
  name: "The Fundability Brief",
  site: "https://underlytix.com",
  from: process.env.NEWSLETTER_FROM_EMAIL || "Herold Pierre <herold@underlytix.com>",
  replyTo: process.env.NEWSLETTER_REPLY_TO || "hpierre00@gmail.com",
  segmentId: "16b25ac0-9513-4996-a01e-64f7216fbe85",
  topicId: "f56bdba7-6c69-49a5-a742-b0ffc81c7b8c",
};
const PAGE = `${CFG.site}/subscribe.html`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sign = (email) => createHmac("sha256", process.env.SIGNUP_SECRET || "").update(email).digest("hex");
const back = (q) => Response.redirect(`${PAGE}?${q}`, 303);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resend allows ~2 requests/second; retry on 429 so back-to-back calls don't fail.
const api = async (path, method, body) => {
  let res;
  for (let i = 0; i < 4; i++) {
    res = await fetch(`https://api.resend.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status !== 429) return res;
    await sleep(700 * (i + 1));
  }
  return res;
};

export default async (req) => {
  if (!process.env.SIGNUP_SECRET || !process.env.RESEND_API_KEY) {
    console.error("[newsletter] SIGNUP_SECRET or RESEND_API_KEY missing");
    return back("error=1");
  }

  if (req.method === "POST") {
    const form = await req.formData();
    if (String(form.get("company") || "").trim()) return back("sent=1"); // honeypot
    const email = String(form.get("email") || "").trim().toLowerCase();
    const first = String(form.get("first_name") || "").trim().slice(0, 60);
    if (!EMAIL_RE.test(email) || email.length > 200) return back("error=1");

    const link = `${CFG.site}/.netlify/functions/newsletter?email=${encodeURIComponent(email)}&first=${encodeURIComponent(first)}&sig=${sign(email)}`;
    const r = await api("/emails", "POST", {
      from: CFG.from,
      to: email,
      reply_to: CFG.replyTo,
      subject: `Confirm your subscription to ${CFG.name}`,
      html: `<p>Hi${first ? " " + esc(first) : ""},</p><p>Please confirm you want ${esc(CFG.name)} by clicking the link below.</p><p><a href="${link}">Confirm my subscription</a></p><p>If you didn't ask for this, ignore this email and nothing will happen.</p>`,
      text: `Confirm your subscription to ${CFG.name}: ${link}\n\nIf you didn't ask for this, ignore this email.`,
    });
    if (!r.ok) {
      console.error("[newsletter] confirmation send failed:", await r.text().catch(() => ""));
      return back("error=1");
    }
    return back("sent=1");
  }

  if (req.method === "GET") {
    const u = new URL(req.url);
    const email = (u.searchParams.get("email") || "").toLowerCase();
    const first = (u.searchParams.get("first") || "").slice(0, 60);
    const sig = u.searchParams.get("sig") || "";
    const good = sign(email);
    if (!EMAIL_RE.test(email) || sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) {
      return back("error=1");
    }
    // Create (or reuse) the contact, then attach segment and topic.
    const c = await api("/contacts", "POST", { email, first_name: first, unsubscribed: false });
    if (!c.ok && c.status !== 409) {
      console.error("[newsletter] create contact failed:", c.status, await c.text().catch(() => ""));
      return back("error=1");
    }
    await sleep(600);
    const s = await api(`/contacts/${encodeURIComponent(email)}/segments/${CFG.segmentId}`, "POST");
    await sleep(600);
    const t = await api(`/contacts/${encodeURIComponent(email)}/topics`, "PATCH", {
      topics: [{ id: CFG.topicId, subscription: "opt_in" }],
    });
    if (!s.ok || !t.ok) {
      console.error("[newsletter] segment/topic failed:", s.status, t.status, await t.text().catch(() => ""));
      return back("error=1");
    }
    return back("confirmed=1");
  }

  return new Response("Method not allowed", { status: 405 });
};
