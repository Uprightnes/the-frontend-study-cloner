import type { Page } from "playwright";

export interface GsapDetectionResult {
  gsapPresent: boolean;
  scrollTriggerPresent: boolean;
  /** Number of ScrollTrigger instances registered, if introspectable. */
  scrollTriggerInstanceCount: number;
}

/**
 * Detects GSAP and ScrollTrigger by checking for their global namespace.
 * Modern bundlers sometimes tree-shake the global away even when GSAP is
 * used internally (ESM imports don't always attach to `window`), so this
 * is a best-effort signal, not a guarantee of absence.
 */
export async function detectGsap(page: Page): Promise<GsapDetectionResult> {
  return await page.evaluate(() => {
    const w = window as any;
    const gsapPresent = !!w.gsap;
    const scrollTriggerPresent = !!w.ScrollTrigger || !!w.gsap?.core?.globals?.()?.ScrollTrigger;
    let scrollTriggerInstanceCount = 0;
    try {
      scrollTriggerInstanceCount = w.ScrollTrigger?.getAll?.()?.length ?? 0;
    } catch {
      scrollTriggerInstanceCount = 0;
    }
    return { gsapPresent, scrollTriggerPresent, scrollTriggerInstanceCount };
  });
}

/**
 * Performs a slow, fine-grained scroll specifically tuned for
 * ScrollTrigger-driven sites. Unlike the generic autoScroll used for
 * lazy-loading, this uses much smaller steps and longer pauses, because
 * ScrollTrigger animations are frequently bound to scroll position with
 * `scrub: true`, meaning the animation state itself depends on exactly
 * where the scrollbar is — jumping in large increments can skip past
 * pinned sections without ever rendering their intermediate frames.
 *
 * This does not "solve" capturing the animation itself (that would
 * require frame-by-frame video capture per scroll position, which is a
 * separate, heavier feature — see captureScrollTriggerFrames below). Its
 * purpose here is just to make sure every pinned section's *end state*
 * DOM and assets get triggered and loaded, the same way autoScroll does
 * for lazy images.
 */
export async function fineGrainedScrollPass(
  page: Page,
  stepPx = 80,
  pauseMs = 150
): Promise<void> {
  await page.evaluate(
    async ({ stepPx, pauseMs }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const maxScroll = document.body.scrollHeight - window.innerHeight;
      for (let y = 0; y <= maxScroll; y += stepPx) {
        window.scrollTo(0, y);
        await sleep(pauseMs);
      }
      window.scrollTo(0, 0);
      await sleep(pauseMs);
    },
    { stepPx, pauseMs }
  );
}

export interface ScrollTriggerFrame {
  scrollY: number;
  screenshotPath: string;
}

/**
 * Captures a screenshot at evenly spaced scroll positions across the full
 * page height. This is the practical "snapshot, don't reconstruct" answer
 * for ScrollTrigger/pinned sections per your stated priority: rather than
 * trying to recover the GSAP timeline code, we record what it looked like
 * at N points along its scroll range, which is useful both as a visual
 * reference in the generated README and as ground truth for manually
 * reconstructing the animation later if desired.
 *
 * frameCount is intentionally modest by default — this is meant as a
 * visual reference artifact, not a full video reconstruction.
 */
export async function captureScrollTriggerFrames(
  page: Page,
  outputDir: string,
  frameCount = 12
): Promise<ScrollTriggerFrame[]> {
  const frames: ScrollTriggerFrame[] = [];
  const maxScroll = await page.evaluate(
    () => document.body.scrollHeight - window.innerHeight
  );

  for (let i = 0; i < frameCount; i++) {
    const scrollY = Math.round((maxScroll / (frameCount - 1)) * i);
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(200); // let any scrub-bound animation settle visually
    const screenshotPath = `${outputDir}/scroll-frame-${String(i).padStart(2, "0")}-y${scrollY}.png`;
    await page.screenshot({ path: screenshotPath });
    frames.push({ scrollY, screenshotPath });
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  return frames;
}
