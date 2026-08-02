import type { Page } from "playwright";
import { CaptureSession } from "./session.js";
import { runThoroughInteractionPass, autoScroll } from "./interactions.js";
import {
  detectGsap,
  fineGrainedScrollPass,
  captureScrollTriggerFrames,
  type GsapDetectionResult,
} from "./gsap.js";
import { snapshotCanvases, extractThreeSceneGraph, type CanvasSnapshot } from "./webgl.js";
import { forceRoutePrefetch, hoverAllInternalLinks } from "./dynamicImports.js";
import { extractComputedStyles } from "./styles.js";
import { discoverSameOriginLinks, extractLinksFromHtml } from "./linkDiscovery.js";
import { detectFramework } from "../analyze/framework.js";
import { detectSourceMaps } from "../analyze/sourceMaps.js";
import { detectExternalDependencies } from "../analyze/externalDeps.js";
import { PoliteRateLimiter } from "../utils/rateLimiter.js";
import { normalizeUrlForDedupe } from "../utils/url.js";
import { checkRobotsTxt } from "../ethics/robots.js";
import { assertConsent } from "../ethics/consent.js";
import {
  DEFAULT_VIEWPORTS,
  type CapturedPage,
  type CaptureResult,
  type CrawlOptions,
  type Viewport,
  type FrameworkDetectionResult,
  type ProgressCallback,
} from "../types/index.js";

export interface CapturePageOutcome {
  page: CapturedPage;
  gsap: GsapDetectionResult;
  canvasSnapshots: CanvasSnapshot[];
  /** Only populated when `detectFrameworkToo` is true for this call. */
  framework?: FrameworkDetectionResult;
}

/**
 * Captures a single URL at a single viewport, running the full
 * interaction/trigger pipeline before extracting the final DOM snapshot.
 * Order matters here: dynamic imports and lazy content should be forced
 * to load *before* we read computed styles or serialize the DOM, so the
 * capture reflects the fully-settled page state.
 *
 * Framework detection is optional per-call (rather than always-on)
 * because it only needs to run once per site, not once per viewport —
 * the caller passes `detectFrameworkToo: true` for exactly one viewport
 * (the first) to avoid redundant work, and critically, to avoid needing
 * a live page *after* the capture session has already been torn down.
 */
async function captureSingleViewport(
  page: Page,
  originUrl: string,
  thorough: boolean,
  viewport: Viewport,
  detectFrameworkToo: boolean
): Promise<CapturePageOutcome> {
  const gsapInfo = await detectGsap(page);
  const framework = detectFrameworkToo ? await detectFramework(page) : undefined;

  if (thorough) {
    await runThoroughInteractionPass(page);
    await forceRoutePrefetch(page, originUrl);
    await hoverAllInternalLinks(page, originUrl);

    if (gsapInfo.scrollTriggerPresent) {
      await fineGrainedScrollPass(page);
    }
  } else {
    // Even in fast mode, do a lightweight scroll pass to trigger
    // IntersectionObserver-based lazy images below the fold. Without this,
    // any image that only loads when scrolled into view is missed entirely.
    // We use a faster step (600px) and shorter pause (120ms) than the full
    // thorough pass to keep fast mode actually fast (~2-3s extra per page).
    await autoScroll(page, 600, 120);
  }

  const canvasSnapshots = await snapshotCanvases(page);
  const computedStyles = await extractComputedStyles(page);
  const renderedHtml = await page.content();

  return {
    page: {
      url: page.url(),
      viewport,
      renderedHtml,
      computedStyles,
    },
    gsap: gsapInfo,
    canvasSnapshots,
    framework,
  };
}

export interface SinglePageCaptureResult {
  pages: CapturedPage[];
  gsapDetected: boolean;
  scrollTriggerFrameDirs: string[];
  threeSceneIntrospectable: boolean;
  framework: FrameworkDetectionResult;
  /** Same-origin links discovered while capturing this page, deduplicated. */
  discoveredLinks: string[];
}

/**
 * Captures one URL across all configured viewports, reusing an
 * already-started CaptureSession. This is the per-page unit of work that
 * both `captureSite` (single page) and `crawlSite` (multi-page) build on
 * top of — extracted here so the session lifecycle (start/stop) is owned
 * by the caller, not duplicated per page, which matters a lot for
 * `crawlSite`: relaunching a browser for every page in a 50-page crawl
 * would be needlessly slow and is exactly the kind of inefficiency a
 * real crawler shouldn't have.
 */
async function capturePageAcrossViewports(
  session: CaptureSession,
  rateLimiter: PoliteRateLimiter,
  pageUrl: string,
  originUrl: string,
  viewports: Viewport[],
  thorough: boolean,
  scrollFrameOutputDir: string | undefined,
  detectFrameworkOnThisPage: boolean,
  onProgress?: ProgressCallback
): Promise<SinglePageCaptureResult> {
  const pages: CapturedPage[] = [];
  let gsapDetectedAny = false;
  let threeSceneIntrospectableAny = false;
  let framework: FrameworkDetectionResult = { frameworks: ["unknown"], cssApproach: "unknown" };
  const scrollTriggerFrameDirs: string[] = [];
  const allDiscoveredLinks = new Set<string>();

  for (const [index, viewport] of viewports.entries()) {
    onProgress?.({ type: "viewport-start", message: viewport.name });

    await rateLimiter.wait();

    const page = await session.openPage(viewport);

    onProgress?.({ type: "navigating", message: pageUrl });
    await session.navigate(page, pageUrl);
    onProgress?.({ type: "navigated", message: pageUrl });

    if (thorough) onProgress?.({ type: "interactions-start", message: viewport.name });

    const outcome = await captureSingleViewport(
      page,
      originUrl,
      thorough,
      viewport,
      detectFrameworkOnThisPage && index === 0
    );

    if (thorough) onProgress?.({ type: "interactions-done", message: viewport.name });

    pages.push(outcome.page);
    if (outcome.framework) framework = outcome.framework;
    if (outcome.gsap.gsapPresent) gsapDetectedAny = true;

    if (outcome.gsap.scrollTriggerPresent && scrollFrameOutputDir) {
      const pageSlug = slugifyUrlForPath(pageUrl);
      const dir = `${scrollFrameOutputDir}/${pageSlug}/${viewport.name}`;
      await captureScrollTriggerFrames(page, dir);
      scrollTriggerFrameDirs.push(dir);
    }

    const sceneInfo = await extractThreeSceneGraph(page);
    if (sceneInfo.introspectable) threeSceneIntrospectableAny = true;

    // Discover links before closing the page. Run on every viewport
    // (not just one) since responsive layouts sometimes hide navigation
    // links behind a mobile-only hamburger menu that desktop never
    // renders, and vice versa for desktop-only footer link sections.
    const linksOnThisViewport = await discoverSameOriginLinks(page, originUrl);
    for (const link of linksOnThisViewport) allDiscoveredLinks.add(link);

    onProgress?.({ type: "viewport-done", message: viewport.name });

    await page.close();
  }

  return {
    pages,
    gsapDetected: gsapDetectedAny,
    scrollTriggerFrameDirs,
    threeSceneIntrospectable: threeSceneIntrospectableAny,
    framework,
    discoveredLinks: Array.from(allDiscoveredLinks),
  };
}

function slugifyUrlForPath(url: string): string {
  const { pathname } = new URL(url);
  const slug = pathname.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "home";
}

export interface CaptureSiteResult extends CaptureResult {
  gsapDetected: boolean;
  scrollTriggerFrameDirs: string[];
  threeSceneIntrospectable: boolean;
}

/**
 * Single-page, multi-viewport capture entrypoint. Use this when you only
 * want to (re-)capture one specific URL. For crawling a whole site by
 * following internal links, use `crawlSite` instead.
 */
export async function captureSite(
  options: CrawlOptions,
  scrollFrameOutputDir?: string
): Promise<CaptureSiteResult> {
  const consent = assertConsent(options.consent);
  const robotsDecision = await checkRobotsTxt(options.targetUrl);
  if (!robotsDecision.allowed) {
    throw new Error(
      `robots.txt disallows crawling ${options.targetUrl}. Refusing to proceed. ` +
        `If you are the site owner and intend to allow this, update robots.txt accordingly.`
    );
  }

  const rateLimiter = new PoliteRateLimiter(
    Math.max(robotsDecision.crawlDelayMs, options.crawlDelayMs ?? 0)
  );
  const viewports = options.viewports ?? DEFAULT_VIEWPORTS;

  const session = new CaptureSession();
  options.onProgress?.({ type: "browser-launch", message: "Launching browser…" });
  await session.start();

  let result: SinglePageCaptureResult;
  try {
    result = await capturePageAcrossViewports(
      session,
      rateLimiter,
      options.targetUrl,
      options.targetUrl,
      viewports,
      options.thorough ?? false,
      scrollFrameOutputDir,
      true,
      options.onProgress
    );
  } finally {
    await session.stop();
  }

  const assets = session.getCapturedAssets();
  const sourceMaps = await detectSourceMaps(assets);
  const externalDependencies = detectExternalDependencies(
    assets,
    new URL(options.targetUrl).origin
  );

  return {
    targetUrl: options.targetUrl,
    capturedAt: consent.acknowledgedAt,
    pages: result.pages,
    assets,
    sourceMaps,
    framework: result.framework,
    externalDependencies,
    gsapDetected: result.gsapDetected,
    scrollTriggerFrameDirs: result.scrollTriggerFrameDirs,
    threeSceneIntrospectable: result.threeSceneIntrospectable,
  };
}

export interface CrawlSiteResult extends CaptureResult {
  gsapDetected: boolean;
  scrollTriggerFrameDirs: string[];
  threeSceneIntrospectable: boolean;
  /** Pages that were discovered (linked to) but never visited, because maxPages was reached. */
  unvisitedDiscoveredUrls: string[];
}

/**
 * Multi-page crawl entrypoint: starts from `options.targetUrl`, follows
 * same-origin links discovered on each page, and captures every page it
 * visits at every configured viewport — up to `options.maxPages` (default
 * 50, per PRD section 6.1).
 *
 * One browser session is shared across the entire crawl. Pages are
 * visited breadth-first (a plain FIFO queue), which in practice means
 * the homepage's direct links get captured before any second-level
 * pages they in turn link to — a reasonable default for a small-to-
 * medium marketing/portfolio site, since it prioritizes broad coverage
 * of top-level navigation over depth into deeply nested pages if the
 * page cap is hit first.
 */
export async function crawlSite(options: CrawlOptions): Promise<CrawlSiteResult> {
  const consent = assertConsent(options.consent);
  const robotsDecision = await checkRobotsTxt(options.targetUrl);
  if (!robotsDecision.allowed) {
    throw new Error(
      `robots.txt disallows crawling ${options.targetUrl}. Refusing to proceed. ` +
        `If you are the site owner and intend to allow this, update robots.txt accordingly.`
    );
  }

  const rateLimiter = new PoliteRateLimiter(
    Math.max(robotsDecision.crawlDelayMs, options.crawlDelayMs ?? 0)
  );
  const viewports = options.viewports ?? DEFAULT_VIEWPORTS;
  const maxPages = options.maxPages ?? 50;
  const originUrl = options.targetUrl;

  const visited = new Set<string>();
  const queue: string[] = [normalizeUrlForDedupe(options.targetUrl)];
  const queuedOrVisited = new Set<string>(queue);

  const allPages: CapturedPage[] = [];
  let gsapDetectedAny = false;
  let threeSceneIntrospectableAny = false;
  let framework: FrameworkDetectionResult = { frameworks: ["unknown"], cssApproach: "unknown" };
  const scrollTriggerFrameDirs: string[] = [];
  let frameworkDetected = false;

  const session = new CaptureSession();
  options.onProgress?.({ type: "browser-launch", message: "Launching browser…" });
  await session.start();

  try {
    while (queue.length > 0 && visited.size < maxPages) {
      const nextUrl = queue.shift()!;
      if (visited.has(nextUrl)) continue;
      visited.add(nextUrl);

      let result: SinglePageCaptureResult;
      try {
        result = await capturePageAcrossViewports(
          session,
          rateLimiter,
          nextUrl,
          originUrl,
          viewports,
          options.thorough ?? false,
          undefined,
          !frameworkDetected,
          options.onProgress
        );
      } catch (err) {
        // A download, navigation timeout, or other page-level error —
        // log it and continue to the next queued URL rather than
        // crashing the entire crawl.
        options.onProgress?.({
          type: "page-complete",
          message: `skipped (error): ${nextUrl}`,
        });
        console.warn(`  ⚠ Skipped ${nextUrl}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        continue;
      }

      options.onProgress?.({ type: "page-complete", message: nextUrl });

      allPages.push(...result.pages);
      if (!frameworkDetected && result.framework.frameworks[0] !== "unknown") {
        framework = result.framework;
        frameworkDetected = true;
      }
      if (result.gsapDetected) gsapDetectedAny = true;
      if (result.threeSceneIntrospectable) threeSceneIntrospectableAny = true;
      scrollTriggerFrameDirs.push(...result.scrollTriggerFrameDirs);

      // Merge live-DOM discovered links with links extracted from the
      // captured renderedHtml. The live-DOM scan (with scroll pass) catches
      // links revealed by lazy rendering; the HTML scan catches links in
      // server-rendered markup that may have been missed if the live page
      // scrolled back to top before link discovery ran on a later viewport.
      const allDiscoveredLinks = new Set(result.discoveredLinks);
      for (const capturedPage of result.pages) {
        const htmlLinks = extractLinksFromHtml(
          capturedPage.renderedHtml,
          capturedPage.url,
          originUrl
        );
        for (const link of htmlLinks) allDiscoveredLinks.add(link);
      }

      for (const link of allDiscoveredLinks) {
        if (!queuedOrVisited.has(link) && visited.size + queue.length < maxPages) {
          queue.push(link);
          queuedOrVisited.add(link);
        }
      }
    }
  } finally {
    await session.stop();
  }

  const unvisitedDiscoveredUrls = queue.filter((url) => !visited.has(url));

  const assets = session.getCapturedAssets();
  const sourceMaps = await detectSourceMaps(assets);
  const externalDependencies = detectExternalDependencies(assets, new URL(originUrl).origin);

  options.onProgress?.({ type: "crawl-complete", message: `${allPages.length / viewports.length} page(s) captured` });

  return {
    targetUrl: options.targetUrl,
    capturedAt: consent.acknowledgedAt,
    pages: allPages,
    assets,
    sourceMaps,
    framework,
    externalDependencies,
    gsapDetected: gsapDetectedAny,
    scrollTriggerFrameDirs,
    threeSceneIntrospectable: threeSceneIntrospectableAny,
    unvisitedDiscoveredUrls,
  };
}
