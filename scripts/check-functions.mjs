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

// ── Report ────────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`\nPre-deploy check failed (${problems.length} issue(s)):\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(`Pre-deploy checks passed: ${fnFiles.length} functions parse cleanly, no duplicate pages.`);
