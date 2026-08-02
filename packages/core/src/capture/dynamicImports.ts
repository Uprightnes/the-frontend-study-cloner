import type { Page } from "playwright";
import { isSameOrigin } from "../utils/url.js";

/**
 * Next.js automatically prefetches the JS chunks for any <Link> visible in
 * the viewport (when using next/link with default prefetch behavior).
 * Forcing every internal link briefly into view is therefore often enough
 * to trigger most route chunks to load, without actually navigating away
 * from the current page — which matters because navigating would lose
 * the current page's already-triggered state (modals opened, lazy content
 * loaded, etc.) per the autoScroll/interaction passes.
 *
 * This is a heuristic, not a guarantee: dynamic imports gated behind
 * runtime conditions (feature flags, user-triggered-only code paths) will
 * still be missed. The PRD's known-limitations section already documents
 * this category; this function reduces it, not eliminates it.
 */
export async function forceRoutePrefetch(page: Page, originUrl: string): Promise<string[]> {
  const internalHrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]")).map(
      (a) => (a as HTMLAnchorElement).href
    );
  });

  const sameOriginHrefs = internalHrefs.filter((href) => isSameOrigin(originUrl, href));
  const uniqueHrefs = Array.from(new Set(sameOriginHrefs));

  for (const href of uniqueHrefs) {
    const locator = page.locator(`a[href="${href}"]`).first();
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 1000 });
      // Give Next.js's IntersectionObserver-based prefetcher a moment to fire.
      await page.waitForTimeout(150);
    } catch {
      // Link may be inside a closed accordion/menu and not scrollable into
      // view without an interaction we haven't triggered — acceptable miss.
    }
  }

  return uniqueHrefs;
}

/**
 * Hovers over each internal link briefly. Some routing setups (and some
 * non-Next.js dynamic import patterns, e.g. React.lazy behind a hover-
 * triggered preload) only fetch the chunk on hover intent rather than on
 * simple viewport visibility. Run after forceRoutePrefetch for a more
 * thorough (but slower) pass.
 */
export async function hoverAllInternalLinks(page: Page, originUrl: string): Promise<void> {
  const links = await page.locator("a[href]").all();
  for (const link of links) {
    try {
      const href = await link.getAttribute("href");
      if (!href || !isSameOrigin(originUrl, href)) continue;
      await link.hover({ timeout: 500 });
      await page.waitForTimeout(100);
    } catch {
      // Not hoverable / detached — skip.
    }
  }
}
