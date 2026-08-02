#!/usr/bin/env node
/**
 * postinstall.ts
 *
 * Runs automatically after `npm install fsc` to download the Playwright
 * Chromium browser that the crawler depends on. This is what makes
 * `npx fsc run <url>` work with zero manual setup steps.
 *
 * Design decisions:
 * - We install only Chromium (not Firefox or WebKit) to keep download size
 *   small (~170MB vs ~450MB for all three browsers).
 * - We skip silently if PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 is set, so CI
 *   environments that manage browser installs separately aren't surprised.
 * - We use the playwright package's own CLI to install, so the browser lands
 *   in Playwright's standard cache directory and is shared across projects.
 * - Failures are warned, not fatal — the CLI will give a clearer error at
 *   runtime if Chromium is actually missing.
 */

import { execSync } from "node:child_process";
import pc from "picocolors";

const SKIP = process.env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] === "1";

if (SKIP) {
  console.log(
    pc.dim("  fsc: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — skipping Chromium install.")
  );
  process.exit(0);
}

console.log("");
console.log(pc.cyan("  fsc") + pc.dim(" — installing Playwright Chromium browser…"));
console.log(pc.dim("  (this runs once; ~170MB download on first install)"));
console.log("");

try {
  execSync("npx playwright install chromium --with-deps", {
    stdio: "inherit",
    // Run in the directory where playwright is actually installed so the
    // npx resolution finds the right version (the one in node_modules/.bin).
    cwd: new URL(".", import.meta.url).pathname,
  });
  console.log("");
  console.log(pc.green("  ✓ Chromium ready."));
  console.log(pc.dim('  Run: npx fsc run <url>'));
  console.log("");
} catch (err) {
  console.warn("");
  console.warn(
    pc.yellow("  ⚠ Chromium install failed — you may need to run manually:")
  );
  console.warn(pc.dim("    npx playwright install chromium"));
  console.warn("");
  // Not fatal — exit 0 so npm install itself succeeds. The CLI will give
  // a clear error at runtime if Chromium is actually missing.
  process.exit(0);
}
