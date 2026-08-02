import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { CapturedAsset, AssetType, Viewport } from "../types/index.js";
import { USER_AGENT } from "../ethics/robots.js";

const RESOURCE_TYPE_MAP: Record<string, AssetType> = {
  document: "document",
  script: "script",
  stylesheet: "stylesheet",
  image: "image",
  font: "font",
  media: "media",
};

export interface CaptureSessionOptions {
  /** Block these resource types from even loading, to save bandwidth/time. Rarely needed. */
  blockResourceTypes?: string[];
  /** Navigation timeout in ms. */
  timeoutMs?: number;
}

/**
 * Wraps a single Playwright browser + context for the duration of a capture
 * run. One CaptureSession is created per crawl; pages within it can be
 * opened at different viewports without re-launching the browser each time.
 */
export class CaptureSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly capturedAssets = new Map<string, CapturedAsset>();

  constructor(private readonly options: CaptureSessionOptions = {}) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent: USER_AGENT,
    });

    // Network interception is set at the context level so it applies to
    // every page opened within this session, regardless of viewport.
    this.context.on("response", async (response) => {
      const request = response.request();
      const resourceType = request.resourceType();
      const mappedType = RESOURCE_TYPE_MAP[resourceType] ?? "other";

      if (this.options.blockResourceTypes?.includes(resourceType)) return;

      const url = response.url();
      let buffer: Buffer | undefined;
      try {
        buffer = await response.body();
      } catch {
        // Body can be unavailable for redirects, aborted requests, etc.
        buffer = undefined;
      }

      this.capturedAssets.set(url, {
        url,
        type: mappedType,
        buffer,
        status: response.status(),
        discoveredViaInteraction: false,
      });
    });
  }

  async stop(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
  }

  /** Opens a new page at the given viewport. Caller is responsible for closing it. */
  async openPage(viewport: Viewport): Promise<Page> {
    if (!this.context) throw new Error("CaptureSession not started. Call start() first.");
    const page = await this.context.newPage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    return page;
  }

  /**
   * Navigates to `url` and waits for the page to settle before returning.
   *
   * We prefer `networkidle` (no network activity for 500ms) because it
   * gives the most complete capture — lazy-loaded images, deferred
   * scripts, etc. all get a chance to fire. But on modern sites with
   * persistent background connections (WebSocket-based realtime backends
   * e.g. Convex/Supabase, analytics beacons that poll on an interval, ad
   * trackers that keep reconnecting) the network may never go fully quiet,
   * so `networkidle` can time out even though the page itself finished
   * loading and rendering long ago.
   *
   * To avoid losing the entire page capture in that case, we fall back to
   * the much weaker (but far more reliable) `load` milestone — the browser
   * has already fired `load` internally regardless of which `waitUntil`
   * value we asked `goto` to resolve on, so this fallback is just "stop
   * waiting for silence and accept what's already rendered."
   */
  async navigate(page: Page, url: string): Promise<void> {
    const timeout = this.options.timeoutMs ?? 30_000;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      if (!isTimeout || page.isClosed()) throw err;

      // The document itself may already have loaded even though the
      // network never went idle — give it a short, separate budget to
      // confirm `load` fired, and accept the page either way rather than
      // failing the whole capture over background chatter.
      await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
    }
  }

  /** Marks an asset as having been discovered only via post-load interaction. */
  markDiscoveredViaInteraction(url: string): void {
    const existing = this.capturedAssets.get(url);
    if (existing) existing.discoveredViaInteraction = true;
  }

  getCapturedAssets(): CapturedAsset[] {
    return Array.from(this.capturedAssets.values());
  }
}
