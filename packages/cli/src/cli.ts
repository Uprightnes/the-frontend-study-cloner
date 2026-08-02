#!/usr/bin/env node
import { Command } from "commander";
import { DEFAULT_VIEWPORTS, generateVisualDiff } from "the-frontend-study-cloner-core";
import { runPipeline } from "./pipeline.js";
import { reporter } from "./reporter.js";

const program = new Command();

program
  .name("fsc")
  .description(
    "Frontend Study Cloner — capture a website's frontend into a working " +
      "local copy for personal study and learning."
  )
  .version("0.2.0");

// ── Shared option parser ───────────────────────────────────────────────────
function addSharedOptions(cmd: Command): Command {
  return cmd
    .argument("<url>", "The target URL to capture")
    .option("-o, --out <dir>", "Output directory base name (suffixed with -run / -study)", "./output")
    .option("-m, --max-pages <n>", "Maximum number of pages to crawl", "50")
    .option("--thorough", "Simulate scroll/hover/click to surface lazy-loaded content", false)
    .option("--mobile-only", "Capture only the mobile viewport (faster)", false)
    .option("--diff", "Generate a side-by-side visual diff (diff.png) after capture", false)
    .option(
      "--yes-i-agree",
      "Skip the interactive consent prompt. Only for your own sites in CI contexts.",
      false
    );
}

function parseShared(url: string, opts: Record<string, string | boolean>) {
  try {
    new URL(url);
  } catch {
    reporter.error(`"${url}" is not a valid URL.`);
    process.exitCode = 1;
    return null;
  }

  const maxPages = Number.parseInt(String(opts["maxPages"]), 10);
  if (!Number.isFinite(maxPages) || maxPages <= 0) {
    reporter.error(`--max-pages must be a positive integer, got "${opts["maxPages"]}".`);
    process.exitCode = 1;
    return null;
  }

  return {
    targetUrl: url,
    outputDir: String(opts["out"]),
    maxPages,
    thorough: Boolean(opts["thorough"]),
    viewports: opts["mobileOnly"] ? mobileOnlyViewport() : undefined,
    yesIAgree: Boolean(opts["yesIAgree"]),
    diff: Boolean(opts["diff"]),
  };
}

// ── fsc run <url> ──────────────────────────────────────────────────────────
addSharedOptions(
  program
    .command("run")
    .description(
      "Capture a site and produce a Run-mode dist-style local copy only. " +
        "Fastest option — no beautification or component inference."
    )
).action(async (url: string, opts) => {
  const shared = parseShared(url, opts);
  if (!shared) return;
  try {
    await runPipeline({ ...shared, runMode: true, studyMode: false });
  } catch (err) {
    reporter.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
});

// ── fsc study <url> ────────────────────────────────────────────────────────
addSharedOptions(
  program
    .command("study")
    .description(
      "Capture a site and produce BOTH a Run-mode working copy AND a Study-mode " +
        "readable codebase (beautified, with inferred components, README, and package.json). " +
        "Output goes into <out>-run/ and <out>-study/ respectively."
    )
).action(async (url: string, opts) => {
  const shared = parseShared(url, opts);
  if (!shared) return;
  try {
    await runPipeline({ ...shared, runMode: true, studyMode: true });
  } catch (err) {
    reporter.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
});

// ── fsc diff <url> <output-dir> ────────────────────────────────────────────
program
  .command("diff")
  .description(
    "Generate a side-by-side visual diff comparing the live site against an " +
      "existing local Run-mode output directory. Saves diff.png, diff-live.png, " +
      "and diff-local.png inside the output directory."
  )
  .argument("<url>", "The live site URL")
  .argument("<output-dir>", "Path to an existing fsc run output directory")
  .option("-w, --width <px>", "Screenshot viewport width", "1440")
  .option("-h, --height <px>", "Screenshot viewport height", "900")
  .action(async (url: string, outputDir: string, opts) => {
    try {
      new URL(url);
    } catch {
      reporter.error(`"${url}" is not a valid URL.`);
      process.exitCode = 1;
      return;
    }

    const width  = Number.parseInt(String(opts["width"]),  10);
    const height = Number.parseInt(String(opts["height"]), 10);

    reporter.step(`Generating visual diff…`);
    reporter.info(`  Live:  ${url}`);
    reporter.info(`  Local: ${outputDir}`);

    try {
      const result = await generateVisualDiff({ liveUrl: url, outputDir, width, height });
      reporter.success(`diff.png      → ${result.diffImagePath}`);
      reporter.info(`diff-live.png  → ${result.liveScreenshotPath}`);
      reporter.info(`diff-local.png → ${result.localScreenshotPath}`);
    } catch (err) {
      reporter.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

function mobileOnlyViewport() {
  const mobile = DEFAULT_VIEWPORTS[0];
  if (!mobile) throw new Error("DEFAULT_VIEWPORTS is unexpectedly empty.");
  return [mobile];
}

program.parseAsync(process.argv);
