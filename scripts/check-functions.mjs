#!/usr/bin/env node
// Syntax-checks every Netlify function before deploy.
//
// Why this exists: capiq-analyze.js shipped for weeks with `var raw` in one branch
// and `const raw` in another. `var` is function-scoped, so that is a SyntaxError —
// the function failed to parse at runtime and Netlify returned a text/plain 502.
// Nothing in the build caught it, and the UI reported it as "Could not find this
// property," which sent debugging in entirely the wrong direction.
//
// Run: node scripts/check-functions.mjs

import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "netlify", "functions");

const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
const broken = [];

for (const file of files) {
  const src = readFileSync(join(dir, file), "utf8");
  // Netlify v2 functions use ESM (`export default`); v1 use CommonJS (`exports.handler`).
  const mode = /^\s*export\s+(default|const)/m.test(src) ? "module" : "commonjs";
  try {
    execFileSync(process.execPath, ["--input-type=" + mode, "--check"], {
      input: src,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = String(err.stderr || err.message)
      .split("\n")
      .find((l) => l.includes("Error")) || "unknown syntax error";
    broken.push({ file, msg: msg.trim() });
  }
}

if (broken.length) {
  console.error(`\n${broken.length} function(s) will fail at runtime:\n`);
  for (const b of broken) console.error(`  ${b.file}\n    ${b.msg}\n`);
  console.error("Fix these before deploying. A parse error returns a 502 with no usable message.\n");
  process.exit(1);
}

console.log(`All ${files.length} Netlify functions parse cleanly.`);
