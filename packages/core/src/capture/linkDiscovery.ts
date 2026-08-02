import type { Page } from "playwright";
import { isSameOrigin, normalizeUrlForDedupe } from "../utils/url.js";

/**
 * Extracts every same-origin link from the current page's rendered DOM,
 * normalized and deduplicated. Run this after any thorough-interaction
 * pass (menus opened, accordions expanded) so links that only appear
 * once revealed are still discovered — this is the same reasoning as
 * forceRoutePrefetch, just for crawl-queue purposes rather than chunk
 * loading.
 *
 * Deliberately excludes:
 *  - Cross-origin links (same-origin lock, per PRD section 9)
 *  - Fragment-only links (#section) and fragment differences on an
 *    otherwise-identical path, since these are anchors within a page
 *    already being captured, not separate pages
 *  - mailto:, tel:, javascript: pseudo-links
 *
 * Also performs a scroll pass before querying so that lazy-rendered
 * navigation sections below the fold are in the DOM, and waits a beat
 * after networkidle to let React hydration finish injecting link hrefs
 * into the rendered DOM.
 */
export async function discoverSameOriginLinks(page: Page, originUrl: string): Promise<string[]> {
  // Wait for React hydration to finish settling after networkidle.
  // Next.js App Router defers some DOM mutations (including inserting href
  // attributes on client-rendered <Link> components) to after the initial
  // paint + hydration cycle. A 500ms settle after networkidle is enough
  // to catch these without meaningfully slowing the crawl.
  await page.waitForTimeout(500);

  // Scroll to the bottom and back to trigger lazy-loaded sections so their
  // <a> tags are in the DOM before we query. Many portfolio sites put their
  // project-page links in a below-the-fold grid that's rendered lazily.
  await scrollToRevealLinks(page);

  // Extract absolute href values from every <a> in the DOM.
  // We use the DOM property `a.href` (not getAttribute) so the browser
  // resolves relative paths to absolute for us.
  const rawHrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]")).map(
      (a) => (a as HTMLAnchorElement).href
    );
  });

  return filterAndNormalize(rawHrefs, page.url(), originUrl);
}

/**
 * Extracts same-origin links from a static HTML string rather than a live
 * Playwright page. Used as a fallback when the live page is unavailable
 * (e.g. when scanning the captured renderedHtml from a previous capture
 * to supplement links that the live-page scan may have missed).
 *
 * href attributes in static HTML are raw values (relative paths, absolute
 * URLs, etc.) — we resolve them against originUrl before filtering.
 */
export function extractLinksFromHtml(html: string, currentPageUrl: string, originUrl: string): string[] {
  const hrefPattern = /href\s*=\s*["']([^"'#][^"']*)["']/gi;
  const rawHrefs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = hrefPattern.exec(html)) !== null) {
    if (m[1]) {
      try {
        rawHrefs.push(new URL(m[1], originUrl).href);
      } catch { /* skip malformed */ }
    }
  }
  return filterAndNormalize(rawHrefs, currentPageUrl, originUrl);
}

/**
 * Scrolls the page in steps from top to bottom, pausing briefly at each
 * step, then scrolls back to top. This triggers IntersectionObserver-based
 * lazy rendering so that below-the-fold navigation links are in the DOM
 * before we query for them.
 */
async function scrollToRevealLinks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const distance = 400; // px per step
      const delay    = 80;  // ms between steps — fast enough to not slow crawl
      let scrolled   = 0;
      const totalHeight = document.body.scrollHeight;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        scrolled += distance;
        if (scrolled >= totalHeight) {
          clearInterval(timer);
          // Scroll back to top so the page screenshot looks right
          window.scrollTo(0, 0);
          resolve();
        }
      }, delay);
    });
  });

  // Brief settle after scroll so lazy components finish rendering
  await page.waitForTimeout(300);
}

/**
 * File extensions that are never crawlable HTML pages. Links pointing at
 * these should be captured as assets by the network interceptor, not
 * navigated to as pages. The crawler navigating to a .woff2 or .pdf
 * triggers a browser download which Playwright throws on.
 */
const NON_PAGE_EXTENSIONS = new Set([
  ".woff", ".woff2", ".ttf", ".otf", ".eot",   // fonts
  ".jpg", ".jpeg", ".png", ".gif", ".webp",      // images
  ".svg", ".ico", ".avif",
  ".mp4", ".webm", ".ogg", ".mp3", ".wav",       // media
  ".pdf", ".zip", ".gz", ".tar",                 // documents/archives
  ".js", ".mjs", ".css",                         // static assets
  ".json", ".xml", ".txt", ".csv",               // data
  ".map",                                        // source maps
]);

function isLikelyPage(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const lastSegment = pathname.split("/").pop() ?? "";
    const dotIdx = lastSegment.lastIndexOf(".");
    if (dotIdx === -1) return true; // no extension → likely a page route
    const ext = lastSegment.slice(dotIdx).toLowerCase();
    return !NON_PAGE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

/**
 * Shared filtering and normalization logic used by both the live-page
 * and static-HTML link extractors.
 */
function filterAndNormalize(
  rawHrefs: string[],
  currentPageUrl: string,
  originUrl: string
): string[] {
  const discovered = new Set<string>();
  const currentNormalized = normalizeUrlForDedupe(currentPageUrl);

  for (const href of rawHrefs) {
    if (!href) continue;
    if (
      href.startsWith("mailto:") ||
      href.startsWith("tel:")     ||
      href.startsWith("javascript:")
    ) continue;

    if (!isSameOrigin(originUrl, href)) continue;

    // Skip anything that looks like a static asset — the network
    // interceptor captures those; navigating to them crashes Playwright.
    if (!isLikelyPage(href)) continue;

    try {
      const normalized = normalizeUrlForDedupe(href);
      if (normalized === currentNormalized) continue;
      discovered.add(normalized);
    } catch {
      continue;
    }
  }

  return Array.from(discovered);
}

