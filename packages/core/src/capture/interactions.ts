import type { Page } from "playwright";

export interface InteractionLog {
  action: "scroll" | "hover" | "click";
  selector?: string;
  note?: string;
}

/**
 * Scrolls the page incrementally to the bottom and back, pausing between
 * steps. This is the single highest-value trick for lazy-loaded content:
 * most lazy-load implementations (IntersectionObserver-based images,
 * scroll-triggered GSAP timelines, infinite-scroll sections) only fire
 * once the element has actually entered the viewport at some point.
 *
 * We scroll back to the top afterward so DOM capture reflects the
 * "natural" initial scroll position, even though everything below has
 * now been triggered and is present in the DOM/network log.
 */
export async function autoScroll(page: Page, stepPx = 400, pauseMs = 250): Promise<void> {
  await page.evaluate(
    async ({ stepPx, pauseMs }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const scrollHeight = () => document.body.scrollHeight;

      let lastHeight = 0;
      let stableCount = 0;

      // Scroll down until height stops growing (handles infinite-scroll
      // sections gracefully by giving up after a few stable readings
      // rather than looping forever).
      while (stableCount < 3) {
        window.scrollBy(0, stepPx);
        await sleep(pauseMs);
        const currentHeight = scrollHeight();
        if (currentHeight === lastHeight) {
          stableCount++;
        } else {
          stableCount = 0;
          lastHeight = currentHeight;
        }
        if (window.scrollY + window.innerHeight >= currentHeight) break;
      }

      // Return to top so the captured "rest state" DOM matches what a
      // visitor would see on first load.
      window.scrollTo(0, 0);
      await sleep(pauseMs);
    },
    { stepPx, pauseMs }
  );
}

/**
 * Hovers over elements matching common "reveal on hover" patterns
 * (dropdown triggers, tooltips, hover-card components). Conservative by
 * design: only targets elements that look like navigation/menu triggers,
 * since hovering arbitrary elements on a heavily-animated site can trigger
 * GSAP timelines in ways that are hard to cleanly reset between captures.
 */
export async function triggerHoverStates(page: Page): Promise<InteractionLog[]> {
  const selectors = [
    "nav [aria-haspopup]",
    "nav button",
    "[data-hover-trigger]",
    ".dropdown-trigger",
  ];
  const log: InteractionLog[] = [];

  for (const selector of selectors) {
    const elements = await page.locator(selector).all();
    for (const element of elements.slice(0, 5)) {
      try {
        await element.hover({ timeout: 1000 });
        await page.waitForTimeout(200);
        log.push({ action: "hover", selector });
      } catch {
        // Element may have become detached or not be hoverable; skip it.
      }
    }
  }
  return log;
}

/**
 * Clicks elements likely to reveal additional content without navigating
 * away (modal triggers, accordion headers, "load more" buttons, tabs).
 * Deliberately excludes anchor tags with external/navigational hrefs and
 * anything resembling a destructive or state-mutating action (forms,
 * buttons with text like "delete", "submit", "buy").
 */
export async function triggerSafeClicks(page: Page): Promise<InteractionLog[]> {
  const selectors = [
    "[data-modal-trigger]",
    "[aria-expanded='false']",
    ".accordion-header",
    ".tab-button",
    "[data-load-more]",
  ];
  const dangerWords = /delete|remove|submit|buy|purchase|checkout|pay|sign\s?out|log\s?out/i;
  const log: InteractionLog[] = [];

  for (const selector of selectors) {
    const elements = await page.locator(selector).all();
    for (const element of elements.slice(0, 10)) {
      try {
        const text = (await element.textContent()) ?? "";
        if (dangerWords.test(text)) continue;

        await element.click({ timeout: 1000, trial: false });
        await page.waitForTimeout(300);
        log.push({ action: "click", selector, note: text.trim().slice(0, 40) });
      } catch {
        // Not clickable, detached, or covered by another element — skip.
      }
    }
  }
  return log;
}

/**
 * Runs the full "thorough" interaction sequence: scroll, hover, click.
 * Returns a log of everything attempted, useful for the generated README
 * ("the following interactions were simulated during capture").
 */
export async function runThoroughInteractionPass(page: Page): Promise<InteractionLog[]> {
  await autoScroll(page);
  const hoverLog = await triggerHoverStates(page);
  const clickLog = await triggerSafeClicks(page);
  return [{ action: "scroll", note: "full-page scroll pass" }, ...hoverLog, ...clickLog];
}
