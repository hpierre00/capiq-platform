#!/usr/bin/env node
// Pre-deploy checks. Run via `npm run check`; also wired into netlify.toml [build].
//
// CHECK 1 — Netlify function syntax.
//   capiq-analyze.js shipped for weeks with `var raw` in one branch and `const raw`
//   in another. `var` is function-scoped, so that is a SyntaxError: the function
//   failed to parse at runtime and Netlify returned a text/plain 502. The build did
//   not catch it, and the UI surfaced it as "Could not find this property," which
//   sent debugging toward the address lookup and the property-data API instead.
//
// CHECK 2 — Duplicate top-level pages.
//   app.html and investor.html were byte-identical 292KB copies, both publicly
//   reachable. Edits landed in the copy that was not served. Fixes appeared to do
//   nothing. If two pages are ever identical again, fail loudly.
//
// CHECK 3 — Inline <script> syntax in top-level HTML pages.
//   Check 1 only covers netlify/functions/*.js. app.html carries ~4000 lines of
//   inline JS (matchDeal, renderResult, the wizard, etc.) that Check 1 never sees.
//   The same duplicate-declaration mistake there would ship the same way: quietly,
//   until a user hits the broken code path.

import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

// ── CHECK 1: function syntax ──────────────────────────────────────────────────
const fnDir = join(root, "netlify", "functions");
const fnFiles = readdirSync(fnDir).filter((f) => f.endsWith(".js"));

for (const file of fnFiles) {
  const src = readFileSync(join(fnDir, file), "utf8");
  // Netlify v2 functions use ESM (`export default`); v1 use CommonJS (`exports.handler`).
  const mode = /^\s*export\s+(default|const)/m.test(src) ? "module" : "commonjs";
  try {
    execFileSync(process.execPath, ["--input-type=" + mode, "--check"], {
      input: src,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg =
      String(err.stderr || err.message).split("\n").find((l) => l.includes("Error")) ||
      "unknown syntax error";
    problems.push(`netlify/functions/${file} will not parse at runtime (502):\n    ${msg.trim()}`);
  }
}

// ── CHECK 2: duplicate top-level pages ────────────────────────────────────────
const MIN_BYTES = 10_000; // ignore small boilerplate pages that legitimately match
const byHash = new Map();

for (const file of readdirSync(root).filter((f) => f.endsWith(".html"))) {
  const buf = readFileSync(join(root, file));
  if (buf.length < MIN_BYTES) continue;
  const hash = createHash("sha256").update(buf).digest("hex");
  if (!byHash.has(hash)) byHash.set(hash, []);
  byHash.get(hash).push(file);
}

for (const files of byHash.values()) {
  if (files.length > 1) {
    problems.push(
      `Identical pages: ${files.join(", ")}\n` +
        `    Two copies means edits can land in the one that is not served.\n` +
        `    Keep one file and route the other URL to it in netlify.toml.`
    );
  }
}

// ── CHECK 3: inline <script> syntax in top-level HTML pages ────────────────────
const htmlFiles = readdirSync(root).filter((f) => f.endsWith(".html"));
let htmlChecked = 0;

for (const file of htmlFiles) {
  const html = readFileSync(join(root, file), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.trim().length > 0 && !/^\s*{/.test(s.trim())); // skip JSON-LD / ld+json blocks
  if (!scripts.length) continue;
  htmlChecked++;
  // Concatenate: these pages define shared top-level functions across multiple
  // <script> tags, so checking each block alone would misreport cross-block
  // references as undefined. Semicolon-join guards against an unterminated
  // statement in one block swallowing the next.
  const combined = scripts.join("\n;\n");
  try {
    execFileSync(process.execPath, ["--input-type=commonjs", "--check"], {
      input: combined,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg =
      String(err.stderr || err.message).split("\n").find((l) => l.includes("Error")) ||
      "unknown syntax error";
    problems.push(`${file} has inline <script> that will not parse:\n    ${msg.trim()}`);
  }
}

// ── CHECK 4: portal pages must lead with marketing when logged out ────────────
//   /realtor and /lender are single-file SPAs whose default (no-JS, logged-out)
//   render is what a crawler and a first-time visitor see. That state must be a
//   marketing page — one <h1>, a marketing nav, no login form, and no portal
//   chrome. The weekly SEO audit extracts body text WITHOUT running CSS or JS, so
//   "display:none" is not enough: the portal chrome must not be in the static
//   markup at all. The credential form lives in a display:none view; the portal
//   topbar controls are injected by JS on auth. Regressed for 5+ audit weeks.
const portalPages = [
  { file: "realtor.html", prefix: "rs" },
  { file: "lender.html", prefix: "lender" },
];

for (const { file, prefix } of portalPages) {
  const html = readFileSync(join(root, file), "utf8");
  const fail = (m) => problems.push(`${file}: ${m}`);

  // Markup a non-JS crawler actually sees: drop <script>/<template> bodies and
  // HTML comments (text extraction ignores all three).
  const staticHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<template[\s\S]*?<\/template>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const h1Count = (staticHtml.match(/<h1[\s>]/g) || []).length;
  if (h1Count !== 1) fail(`expected exactly one <h1>, found ${h1Count}`);

  if (/demo123|DEMO:\s*portal@/.test(html)) {
    fail("demo credentials present in page source — must not ship to anonymous visitors");
  }

  const marketingTopbar = `id="${prefix}-topbar-marketing"`;
  const signinView = `id="${prefix}-signin-view"`;
  if (!staticHtml.includes(marketingTopbar)) fail(`missing logged-out marketing topbar (${marketingTopbar})`);
  if (!staticHtml.includes(signinView)) fail(`missing dedicated sign-in view (${signinView})`);

  // The sign-in view container must be hidden by default.
  const signinTag = new RegExp(`<div[^>]*${signinView}[^>]*>`).exec(staticHtml)?.[0] || "";
  if (signinTag && !/display\s*:\s*none/.test(signinTag)) {
    fail("sign-in view is not display:none by default");
  }

  // No password field may appear before the sign-in view starts — that would put
  // it in the default-visible marketing view. login-view precedes signin-view in
  // source order, so the earliest password input must sit at or after signin-view.
  const firstPw = staticHtml.indexOf('type="password"');
  const signinAt = staticHtml.indexOf(signinView);
  if (firstPw !== -1 && signinAt !== -1 && firstPw < signinAt) {
    fail("a password input renders in the default-visible view (should be inside the sign-in view)");
  }

  // Portal chrome text must not be in the static markup at all — the audit reads
  // body text with no CSS, so hidden nodes still count. These strings may only
  // appear inside <script> (JS-injected on auth), which staticHtml has removed.
  for (const phrase of ["Sign Out", "Manage / Cancel", "REALTOR PORTAL", "LENDER PORTAL"]) {
    if (staticHtml.includes(phrase)) {
      fail(`portal chrome "${phrase}" is in the static HTML — inject it via JS on auth instead`);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`\nPre-deploy check failed (${problems.length} issue(s)):\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(
  `Pre-deploy checks passed: ${fnFiles.length} functions and ${htmlChecked} HTML page(s) parse cleanly, no duplicate pages.`
);
