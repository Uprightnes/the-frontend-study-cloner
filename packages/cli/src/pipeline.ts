import path from "node:path";
import {
  crawlSite,
  assembleRunMode,
  assembleStudyMode,
  generateVisualDiff,
  ConsentRequiredError,
  type CrawlOptions,
  type CaptureResult,
  type Viewport,
} from "the-frontend-study-cloner-core";
import { promptForConsent } from "./consentPrompt.js";
import { reporter } from "./reporter.js";

export interface PipelineOptions {
  targetUrl: string;
  outputDir: string;
  maxPages: number;
  thorough: boolean;
  viewports?: Viewport[];
  yesIAgree?: boolean;
  /** If true, produce the Run-mode dist-style output. Default: true. */
  runMode?: boolean;
  /** If true, also produce the Study-mode readable output. Default: false. */
  studyMode?: boolean;
  /**
   * If true, automatically generate a visual diff (diff.png) after Run mode
   * completes, comparing the live site against the local output. Default: false.
   * Adds ~10s to the run time (two extra browser navigations + screenshot).
   */
  diff?: boolean;
}

/**
 * Shared pipeline: crawl → assemble Run mode → (optionally) assemble
 * Study mode. Both the "run" and "study" CLI subcommands funnel through
 * here rather than duplicating crawl + consent logic in two places.
 */
export async function runPipeline(options: PipelineOptions): Promise<void> {
  const doRun = options.runMode ?? true;
  const doStudy = options.studyMode ?? false;

  reporter.step(`Preparing to capture ${options.targetUrl}`);

  const consent = options.yesIAgree
    ? { acknowledged: true as const, acknowledgedAt: new Date().toISOString() }
    : await promptForConsent(options.targetUrl);

  if (!consent) {
    reporter.warn("Consent not given. Aborting — no crawl was performed.");
    return;
  }

  const crawlOptions: CrawlOptions = {
    targetUrl: options.targetUrl,
    maxPages: options.maxPages,
    thorough: options.thorough,
    viewports: options.viewports,
    consent,
    onProgress: (event) => {
      switch (event.type) {
        case "browser-launch":
          reporter.step(event.message);
          break;
        case "navigating":
          reporter.step(`Loading ${event.message}…`);
          break;
        case "navigated":
          reporter.info(`  Page loaded`);
          break;
        case "viewport-start":
          reporter.info(`  → ${event.message} viewport`);
          break;
        case "interactions-start":
          reporter.info(`  Simulating interactions (scroll/hover/click)…`);
          break;
        case "interactions-done":
          reporter.info(`  Interactions complete`);
          break;
        case "viewport-done":
          reporter.info(`  ✓ ${event.message} captured`);
          break;
        case "page-complete":
          reporter.success(`Page complete: ${event.message}`);
          break;
        case "crawl-complete":
          reporter.info(event.message);
          break;
      }
    },
  };

  reporter.step(
    `Crawling (max ${options.maxPages} page(s), ${options.thorough ? "thorough" : "fast"} mode)…`
  );

  let captureResult: CaptureResult & { gsapDetected: boolean; threeSceneIntrospectable: boolean };
  try {
    captureResult = await crawlSite(crawlOptions);
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      reporter.error(err.message);
      return;
    }
    throw err;
  }

  reporter.success(
    `Captured ${captureResult.pages.length} page snapshot(s), ` +
    `${captureResult.assets.length} asset(s)`
  );

  if (captureResult.framework.frameworks[0] !== "unknown") {
    reporter.info(`Detected framework: ${captureResult.framework.frameworks.join(", ")}`);
  }
  if (captureResult.gsapDetected) {
    reporter.info("GSAP/ScrollTrigger detected — scroll-frame reference screenshots captured.");
  }
  if (captureResult.sourceMaps.some((m) => m.confirmed)) {
    const count = captureResult.sourceMaps.filter((m) => m.confirmed).length;
    reporter.success(
      `${count} confirmed source map(s) — Study mode will produce near-original fidelity for these bundles.`
    );
  }

  if (doRun) {
    const runDir = path.resolve(options.outputDir + "-run");
    reporter.step(`Assembling Run mode → ${runDir}`);
    const runResult = await assembleRunMode(captureResult, runDir);
    reporter.success(`Run mode: ${runResult.filesWritten.length} file(s) written.`);
    printWarnings(runResult.warnings);
    console.log("");
    reporter.info(`To view: cd ${runDir} && npx serve .`);

    if (options.diff) {
      reporter.step("Generating visual diff (live vs local)…");
      try {
        const diffResult = await generateVisualDiff({
          liveUrl: options.targetUrl,
          outputDir: runDir,
        });
        reporter.success(`Visual diff saved → ${diffResult.diffImagePath}`);
      } catch (err) {
        reporter.warn(`Visual diff failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (doStudy) {
    const studyDir = path.resolve(options.outputDir + "-study");
    reporter.step(`Assembling Study mode → ${studyDir}`);
    const studyResult = await assembleStudyMode(captureResult, {
      outputDir: studyDir,
      gsapDetected: captureResult.gsapDetected,
      threeSceneIntrospectable: captureResult.threeSceneIntrospectable,
    });
    reporter.success(
      `Study mode: ${studyResult.filesWritten.length} file(s) written, ` +
      `${studyResult.componentCount} component(s) inferred.`
    );
    printWarnings(studyResult.warnings);
    console.log("");
    reporter.info(`Study output: ${studyDir}/`);
    reporter.info(`README: ${studyDir}/README.md`);
  }

  console.log("");
  reporter.success("Done.");
}

function printWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  console.log("");
  reporter.warn(`${warnings.length} warning(s):`);
  for (const w of warnings) {
    console.log(`  ${w}`);
  }
}
