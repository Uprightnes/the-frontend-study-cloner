#!/usr/bin/env node
// postinstall-guard.mjs
// Runs during `npm install fsc` (published package).
// Skips silently when dist/ hasn't been built yet (local development).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const postinstallDist = path.join(__dirname, "packages", "cli", "dist", "postinstall.js");

if (!existsSync(postinstallDist)) {
  // Local dev: dist hasn't been built yet — skip silently.
  process.exit(0);
}

const result = spawnSync(process.execPath, [postinstallDist], { stdio: "inherit" });
process.exit(result.status ?? 0);
