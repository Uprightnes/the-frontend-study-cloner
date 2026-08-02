import { createRequire } from "node:module";
import type { RobotsDecision } from "../types/index.js";

/**
 * robots-parser ships a broken .d.ts: it declares both an ambient
 * `declare module 'robots-parser';` AND a real `export default function`
 * in the same file, and the ambient declaration wins, making TypeScript
 * see the module as untyped rather than as the documented function. We
 * work around this with createRequire (clean CJS interop under NodeNext)
 * and declare the shape ourselves rather than fighting the upstream types.
 */
const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser") as (
  url: string,
  contents: string
) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
};

const DEFAULT_CRAWL_DELAY_MS = 2000;
const USER_AGENT = "FrontendStudyClonerBot/0.1 (+https://github.com/your-org/frontend-study-cloner)";

/**
 * Fetches and evaluates robots.txt for a given target URL.
 *
 * This is a required gate, not an optional check (see PRD section 9,
 * "Ethical and Legal Requirements"). Callers must not proceed with a crawl
 * if `allowed` is false, and must not silently fall back to "allow" on
 * ambiguous responses without surfacing that ambiguity to the user.
 *
 * If robots.txt cannot be fetched at all (network error, no such file),
 * we treat that as "no explicit restriction found" and allow crawling,
 * which matches how robots.txt is conventionally interpreted by
 * well-behaved crawlers. This is different from an explicit `Disallow: /`,
 * which we will always honor.
 */
export async function checkRobotsTxt(targetUrl: string): Promise<RobotsDecision> {
  const robotsUrl = new URL("/robots.txt", targetUrl).href;

  let rawText: string | null = null;
  try {
    const res = await fetch(robotsUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.ok) {
      rawText = await res.text();
    }
  } catch {
    // Network failure fetching robots.txt itself — treat as "not found".
    rawText = null;
  }

  if (rawText === null) {
    return {
      allowed: true,
      crawlDelayMs: DEFAULT_CRAWL_DELAY_MS,
      rawText: null,
    };
  }

  const robots = robotsParser(robotsUrl, rawText);
  const targetPath = new URL(targetUrl).pathname || "/";
  const allowed = robots.isAllowed(targetPath, USER_AGENT) ?? true;
  const declaredDelaySeconds = robots.getCrawlDelay(USER_AGENT);
  const crawlDelayMs = declaredDelaySeconds
    ? Math.max(declaredDelaySeconds * 1000, DEFAULT_CRAWL_DELAY_MS)
    : DEFAULT_CRAWL_DELAY_MS;

  return { allowed, crawlDelayMs, rawText };
}

export { USER_AGENT };
