/**
 * Underlytix — site-wide Help & Support widget.
 *
 * Self-contained: injects its own styles and DOM, so including it is just
 * one script tag before </body> on any page:
 *   <script src="/support-widget.js" defer></script>
 *
 * Floating launcher (bottom-right) opens a panel with a short FAQ and a
 * contact form that POSTs to /.netlify/functions/contact-form, which emails
 * the submission via Resend. This widget's FAQ is intentionally short — the
 * full FAQ lives inline on the homepage (.faq-section in index.html); this
 * is a fast-answer + escape-hatch-to-a-human layer for every other page.
 *
 * Colors are pulled from the site's existing :root palette (--navy, --teal,
 * --bg, --border, --text) so it matches without depending on page CSS being
 * loaded in a particular order.
 */
(function () {
  'use strict';

  if (window.__underlytixSupportWidgetLoaded) return;
  window.__underlytixSupportWidgetLoaded = true;

  var FAQS = [
    {
      q: 'Is Underlytix a lender or mortgage company?',
      a: 'No. Underlytix is a pre-application intelligence platform — we score deals against real lender criteria before any lender interaction. We don’t originate loans or guarantee financing; all financing decisions are made by lenders.'
    },
    {
      q: 'How fast do I get results?',
      a: 'Capital readiness scoring and lender matching happen in under 60 seconds once you submit deal details — no waiting on a loan officer.'
    },
    {
      q: 'Is my deal data kept private?',
      a: 'Yes. Your deal information is only used to score fundability and match you to lenders — it isn’t sold or shared outside that purpose.'
    },
    {
      q: 'Can I cancel or change my plan anytime?',
      a: 'Yes, plans are month-to-month with no long-term contract. You can upgrade, downgrade, or cancel from your account settings at any time.'
    }
  ];

  var TOPICS = [
    { value: 'general',  label: 'General' },
    { value: 'investor', label: 'Investor' },
    { value: 'realtor',  label: 'Realtor' },
    { value: 'lender',   label: 'Lender' },
    { value: 'billing',  label: 'Billing' }
  ];

  var css = ''
    + '.uw-launcher{position:fixed;bottom:90px;right:24px;z-index:99998;width:56px;height:56px;border-radius:50%;'
    + 'background:var(--navy,#0f2240);color:#fff;border:none;cursor:pointer;box-shadow:0 8px 24px rgba(15,34,64,0.25);'
    + 'display:flex;align-items:center;justify-content:center;font-size:24px;transition:transform .15s,background .15s;}'
    + '.uw-launcher:hover{background:var(--teal,#0e7490);transform:scale(1.06);}'
    + '.uw-launcher.uw-open{background:var(--teal,#0e7490);}'
    + '.uw-panel{position:fixed;bottom:158px;right:24px;z-index:99999;width:360px;max-width:calc(100vw - 32px);'
    + 'max-height:min(600px,calc(100vh - 200px));background:var(--bg-2,#fff);border:1px solid var(--border,#e2e8f0);'
    + 'border-radius:14px;box-shadow:0 20px 48px rgba(15,34,64,0.2);display:none;flex-direction:column;overflow:hidden;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'
    + '.uw-panel.uw-open{display:flex;}'
    + '.uw-head{background:var(--navy,#0f2240);color:#fff;padding:18px 20px;flex-shrink:0;}'
    + '.uw-head h3{margin:0;font-size:15px;font-weight:700;}'
    + '.uw-head p{margin:4px 0 0;font-size:12px;color:rgba(255,255,255,0.65);}'
    + '.uw-body{overflow-y:auto;padding:16px 20px 20px;}'
    + '.uw-faq-label{font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--teal,#0e7490);text-transform:uppercase;margin:4px 0 10px;}'
    + '.uw-faq details{border:1px solid var(--border,#e2e8f0);border-radius:8px;margin-bottom:8px;}'
    + '.uw-faq summary{list-style:none;padding:11px 14px;font-size:13px;font-weight:600;color:var(--text,#0f172a);cursor:pointer;'
    + 'display:flex;justify-content:space-between;align-items:center;}'
    + '.uw-faq summary::-webkit-details-marker{display:none;}'
    + '.uw-faq summary::after{content:"+";font-size:16px;color:var(--teal,#0e7490);margin-left:10px;flex-shrink:0;}'
    + '.uw-faq details[open] summary::after{content:"\\2212";}'
    + '.uw-faq .uw-faq-a{padding:0 14px 12px;font-size:12.5px;color:var(--text-2,#334155);line-height:1.6;}'
    + '.uw-divider{border:none;border-top:1px solid var(--border,#e2e8f0);margin:16px 0;}'
    + '.uw-form-label{font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--teal,#0e7490);text-transform:uppercase;margin:0 0 10px;}'
    + '.uw-field{margin-bottom:10px;}'
    + '.uw-field input,.uw-field select,.uw-field textarea{width:100%;box-sizing:border-box;padding:9px 11px;font-size:13px;'
    + 'border:1px solid var(--border,#e2e8f0);border-radius:7px;font-family:inherit;color:var(--text,#0f172a);background:#fff;}'
    + '.uw-field input:focus,.uw-field select:focus,.uw-field textarea:focus{outline:none;border-color:var(--teal,#0e7490);}'
    + '.uw-field textarea{resize:vertical;min-height:70px;}'
    + '.uw-hp{position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;}'
    + '.uw-submit{width:100%;padding:11px;background:var(--teal,#0e7490);color:#fff;border:none;border-radius:8px;'
    + 'font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s;}'
    + '.uw-submit:hover{background:var(--teal-light,#0891b2);}'
    + '.uw-submit:disabled{opacity:.6;cursor:default;}'
    + '.uw-status{font-size:12.5px;margin-top:10px;padding:9px 11px;border-radius:7px;display:none;}'
    + '.uw-status.uw-ok{display:block;background:var(--green-dim,rgba(5,150,105,0.08));color:var(--green,#059669);}'
    + '.uw-status.uw-err{display:block;background:var(--red-dim,rgba(220,38,38,0.08));color:var(--red,#dc2626);}'
    + '.uw-close{position:absolute;top:14px;right:16px;background:none;border:none;color:rgba(255,255,255,0.7);'
    + 'font-size:18px;cursor:pointer;line-height:1;padding:2px;}'
    + '.uw-close:hover{color:#fff;}'
    + '@media (max-width:480px){.uw-panel{right:16px;left:16px;width:auto;}.uw-launcher{right:16px;}}';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var launcher = document.createElement('button');
  launcher.className = 'uw-launcher';
  launcher.setAttribute('aria-label', 'Help & Support');
  launcher.innerHTML = '&#9993;';

  var panel = document.createElement('div');
  panel.className = 'uw-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Help & Support');

  var faqHtml = FAQS.map(function (f) {
    return '<details><summary>' + f.q + '</summary><div class="uw-faq-a">' + f.a + '</div></details>';
  }).join('');

  var topicOptions = TOPICS.map(function (t) {
    return '<option value="' + t.value + '">' + t.label + '</option>';
  }).join('');

  panel.innerHTML =
    '<div class="uw-head" style="position:relative">'
    + '<button class="uw-close" type="button" aria-label="Close">&times;</button>'
    + '<h3>Help &amp; Support</h3>'
    + '<p>Quick answers, or send us a message.</p>'
    + '</div>'
    + '<div class="uw-body">'
    + '<div class="uw-faq-label">Quick answers</div>'
    + '<div class="uw-faq">' + faqHtml + '</div>'
    + '<hr class="uw-divider">'
    + '<div class="uw-form-label">Still need help? Send a message</div>'
    + '<form id="uw-contact-form" novalidate>'
    + '<div class="uw-field"><input type="text" name="name" placeholder="Your name" required></div>'
    + '<div class="uw-field"><input type="email" name="email" placeholder="Your email" required></div>'
    + '<div class="uw-field"><select name="topic">' + topicOptions + '</select></div>'
    + '<div class="uw-field"><textarea name="message" placeholder="How can we help?" required></textarea></div>'
    + '<input class="uw-hp" type="text" name="company" tabindex="-1" autocomplete="off">'
    + '<button class="uw-submit" type="submit">Send Message</button>'
    + '<div class="uw-status" id="uw-status"></div>'
    + '</form>'
    + '</div>';

  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    wire();
  });
  // In case this script runs after DOMContentLoaded already fired (defer + slow parse edge case)
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    wire();
  }

  function wire() {
    var isOpen = false;
    function setOpen(open) {
      isOpen = open;
      panel.classList.toggle('uw-open', open);
      launcher.classList.toggle('uw-open', open);
      launcher.innerHTML = open ? '&times;' : '&#9993;';
      launcher.setAttribute('aria-label', open ? 'Close Help & Support' : 'Help & Support');
    }
    launcher.addEventListener('click', function () { setOpen(!isOpen); });
    panel.querySelector('.uw-close').addEventListener('click', function () { setOpen(false); });

    var form = panel.querySelector('#uw-contact-form');
    var status = panel.querySelector('#uw-status');
    var submitBtn = form.querySelector('.uw-submit');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      status.className = 'uw-status';
      status.textContent = '';

      var data = {
        name:    form.name.value.trim(),
        email:   form.email.value.trim(),
        topic:   form.topic.value,
        message: form.message.value.trim(),
        company: form.company.value // honeypot
      };

      if (!data.name || !data.email || !data.message) {
        status.className = 'uw-status uw-err';
        status.textContent = 'Please fill in your name, email, and message.';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      fetch('/.netlify/functions/contact-form', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data)
      })
        .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, json: json }; }); })
        .then(function (result) {
          if (result.ok && result.json && result.json.ok) {
            status.className = 'uw-status uw-ok';
            status.textContent = 'Message sent — we’ll get back to you soon.';
            form.reset();
          } else {
            status.className = 'uw-status uw-err';
            status.textContent = (result.json && result.json.error) || 'Something went wrong. Please try again or email support@underlytix.com.';
          }
        })
        .catch(function () {
          status.className = 'uw-status uw-err';
          status.textContent = 'Network error. Please try again or email support@underlytix.com.';
        })
        .finally(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send Message';
        });
    });
  }
})();
