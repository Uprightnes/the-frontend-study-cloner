import type { Page } from "playwright";
import type { DetectedFramework, FrameworkDetectionResult } from "../types/index.js";

/**
 * Detects framework(s) via DOM/global signals visible at runtime, plus
 * Next.js-specific markers since that's your stack. Returns multiple
 * frameworks only in the rare case a page genuinely mixes them (e.g. a
 * Next.js app embedding a separately-built micro-frontend).
 */
export async function detectFramework(page: Page): Promise<FrameworkDetectionResult> {
  const signals = await page.evaluate(() => {
    const w = window as any;
    return {
      hasNext: !!w.__NEXT_DATA__,
      hasReact: !!w.__NEXT_DATA__ || !!w.React || !!document.querySelector("[data-reactroot]"),
      hasVue: !!w.Vue || !!w.__VUE__,
      hasNuxt: !!w.__NUXT__,
      hasAngular: !!document.querySelector("[ng-version]"),
      hasSvelte: !!document.querySelector('[class*="svelte-"]'),
      hasTailwindClasses: !!document.querySelector(
        '[class~="flex"], [class~="grid"], [class*="bg-"], [class*="text-"]'
      ),
      hasBootstrapClasses: !!document.querySelector('[class*="col-"], [class*="btn-"]'),
      hasCssModuleClasses: !!document.querySelector('[class*="_module__"], [class$="-module"]'),
    };
  });

  const frameworks: DetectedFramework[] = [];
  if (signals.hasNext) frameworks.push("next");
  else if (signals.hasReact) frameworks.push("react");
  if (signals.hasNuxt) frameworks.push("nuxt");
  else if (signals.hasVue) frameworks.push("vue");
  if (signals.hasAngular) frameworks.push("angular");
  if (signals.hasSvelte) frameworks.push("svelte");
  if (frameworks.length === 0) frameworks.push("unknown");

  let cssApproach: FrameworkDetectionResult["cssApproach"] = "unknown";
  if (signals.hasTailwindClasses) cssApproach = "tailwind";
  else if (signals.hasCssModuleClasses) cssApproach = "css-modules";
  else if (signals.hasBootstrapClasses) cssApproach = "bootstrap";
  else cssApproach = "plain-css";

  return { frameworks, cssApproach };
}
