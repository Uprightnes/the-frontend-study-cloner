/**
 * visualDiff.ts
 *
 * Takes a screenshot of the live site and a screenshot of the local Run-mode
 * output served from disk, then composites them into a side-by-side comparison
 * PNG saved inside the output directory.
 *
 * This serves two purposes:
 *   1. Validation — lets you instantly see how close the capture is without
 *      manually opening both in a browser and eyeballing.
 *   2. Marketing — the comparison image is the most compelling thing you can
 *      put in the README. One picture is worth a thousand lines of explanation.
 *
 * Implementation notes
 * --------------------
 * We use Playwright (already a dependency) for both screenshots, so there are
 * no new dependencies.
 *
 * The local output is served via Node's built-in `http` module as a minimal
 * static file server — no `serve` or `http-server` package needed. We pick an
 * ephemeral port, serve the output directory, take the screenshot, then shut
 * down. This is safer than asking the user to have `serve` installed.
 *
 * The side-by-side composite is built using raw PNG manipulation via the
 * `canvas` API... except we don't want a native module dependency. Instead we
 * use Playwright's own screenshot capability to render an HTML page that
 * displays both images side by side, then screenshot *that* — a pure-JS, no
 * native-dep approach that works on all platforms.
 *
 * Output file: <outputDir>/diff.png
 */

import { chromium } from "playwright";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, access } from "node:fs/promises";
import { join, extname } from "node:path";
import { constants } from "node:fs";

// MIME types for the minimal static server
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".css":  "text/css",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".json": "application/json",
};

export interface VisualDiffOptions {
  /** The live site URL to screenshot. */
  liveUrl: string;
  /** Path to the Run-mode output directory to serve and screenshot. */
  outputDir: string;
  /**
   * Viewport width for both screenshots. Default: 1440 (desktop, matching
   * our standard capture viewport so the comparison is apples-to-apples).
   */
  width?: number;
  /** Viewport height. Default: 900. */
  height?: number;
  /**
   * How long to wait after navigation before taking the screenshot, in ms.
   * Gives JS/CSS animations time to settle. Default: 2000.
   */
  settleMs?: number;
}

export interface VisualDiffResult {
  /** Absolute path to the written diff.png file. */
  diffImagePath: string;
  /** Path to the live screenshot (kept alongside diff.png for debugging). */
  liveScreenshotPath: string;
  /** Path to the local screenshot. */
  localScreenshotPath: string;
}

/**
 * Starts a minimal static file server rooted at `dir`, returns the
 * server instance and the URL it's listening on.
 */
async function startStaticServer(dir: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      let urlPath = req.url ?? "/";
      // Strip query strings — our static output doesn't need them
      const qIdx = urlPath.indexOf("?");
      if (qIdx !== -1) urlPath = urlPath.slice(0, qIdx);

      // Decode %xx escapes
      try { urlPath = decodeURIComponent(urlPath); } catch { /* leave as-is */ }

      // Map / → /index.html, /about → /about.html if no extension
      let filePath = join(dir, urlPath);
      if (urlPath.endsWith("/") || urlPath === "") {
        filePath = join(dir, "index.html");
      } else if (!extname(urlPath)) {
        // Try with .html extension first (preserveStructure produces about.html etc.)
        const withHtml = filePath + ".html";
        try {
          await access(withHtml, constants.R_OK);
          filePath = withHtml;
        } catch {
          // Fall through to serving as-is (might be a directory index)
          filePath = join(dir, urlPath, "index.html");
        }
      }

      try {
        const body = await readFile(filePath);
        const ext = extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        // SPA fallback: serve root index.html for any missing path
        try {
          const fallback = await readFile(join(dir, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(fallback);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not determine server port"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });

    server.on("error", reject);
  });
}

/**
 * Generates a side-by-side visual diff comparing the live site against the
 * local Run-mode output.
 *
 * Both screenshots are taken at the same viewport size with the same browser,
 * making the comparison as fair as possible.
 *
 * Saves three files inside `options.outputDir`:
 *   diff.png          — side-by-side composite (live | local)
 *   diff-live.png     — live site screenshot alone
 *   diff-local.png    — local output screenshot alone
 */
export async function generateVisualDiff(
  options: VisualDiffOptions
): Promise<VisualDiffResult> {
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  const settleMs = options.settleMs ?? 2000;

  const liveScreenshotPath  = join(options.outputDir, "diff-live.png");
  const localScreenshotPath = join(options.outputDir, "diff-local.png");
  const diffImagePath       = join(options.outputDir, "diff.png");

  // Start a local static server for the output directory
  const { server, url: localUrl } = await startStaticServer(options.outputDir);

  let livePng: Buffer;
  let localPng: Buffer;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      // Disable animations for a cleaner, more stable screenshot
      reducedMotion: "reduce",
    });

    // ── Live site screenshot ───────────────────────────────────────────────
    const livePage = await context.newPage();
    await livePage.goto(options.liveUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await livePage.waitForTimeout(settleMs);
    livePng = await livePage.screenshot({ fullPage: false, type: "png" });
    await livePage.close();

    // ── Local output screenshot ────────────────────────────────────────────
    const localPage = await context.newPage();
    await localPage.goto(localUrl, { waitUntil: "networkidle", timeout: 15_000 });
    await localPage.waitForTimeout(settleMs);
    localPng = await localPage.screenshot({ fullPage: false, type: "png" });
    await localPage.close();

    // ── Side-by-side composite via an HTML page screenshotted by Playwright ─
    // We embed both images as base64 data URIs in an HTML layout page,
    // then take a screenshot of that page. This avoids any native image
    // processing dependency — Playwright handles the compositing.
    const liveB64  = livePng.toString("base64");
    const localB64 = localPng.toString("base64");

    const compositeHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0f0f0f;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
  }
  .header {
    display: flex;
    justify-content: space-between;
    padding: 12px 24px;
    background: #1a1a1a;
    border-bottom: 1px solid #333;
  }
  .label {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .label .url {
    font-weight: 400;
    color: #888;
    margin-left: 8px;
    text-transform: none;
    letter-spacing: 0;
  }
  .live-label  { color: #60a5fa; }
  .local-label { color: #34d399; }
  .images {
    display: flex;
    gap: 2px;
    background: #333;
  }
  .pane {
    flex: 1;
    background: #fff;
  }
  img {
    display: block;
    width: 100%;
    height: auto;
  }
  .divider {
    width: 2px;
    background: #333;
    flex-shrink: 0;
    position: relative;
    display: flex;
    align-items: flex-start;
    padding-top: 16px;
    justify-content: center;
  }
  .divider-label {
    background: #333;
    color: #888;
    font-size: 10px;
    font-weight: 700;
    padding: 4px 6px;
    border-radius: 4px;
    writing-mode: vertical-rl;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="label live-label">
      Live <span class="url">${options.liveUrl}</span>
    </div>
    <div class="label local-label">
      Local output <span class="url">fsc run</span>
    </div>
  </div>
  <div class="images">
    <div class="pane">
      <img src="data:image/png;base64,${liveB64}" alt="Live site">
    </div>
    <div class="divider"><span class="divider-label">vs</span></div>
    <div class="pane">
      <img src="data:image/png;base64,${localB64}" alt="Local output">
    </div>
  </div>
</body>
</html>`;

    const compositePage = await context.newPage();
    await compositePage.setContent(compositeHtml, { waitUntil: "load" });
    // Wait for images to render — they're data URIs so this should be instant,
    // but a small settle gives the layout engine time to finish.
    await compositePage.waitForTimeout(300);

    // Size the composite viewport to fit both images side by side
    await compositePage.setViewportSize({ width: width * 2 + 2, height: height + 48 });
    const compositePng = await compositePage.screenshot({
      fullPage: true,
      type: "png",
    });
    await compositePage.close();

    await context.close();

    // Write all three output files
    await writeFile(liveScreenshotPath,  livePng);
    await writeFile(localScreenshotPath, localPng);
    await writeFile(diffImagePath,       compositePng);

  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { diffImagePath, liveScreenshotPath, localScreenshotPath };
}
