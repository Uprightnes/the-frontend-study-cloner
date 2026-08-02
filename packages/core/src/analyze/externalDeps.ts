import type { CapturedAsset } from "../types/index.js";

/**
 * Scans captured JS/CSS for absolute URLs pointing at domains other than
 * the target site's own origin. These are flagged in the generated README
 * because they represent things that will NOT work in a local/offline
 * copy (CDNs are usually fine since they're public; analytics/API calls
 * will silently fail or, worse, silently succeed against the live site).
 */
export function detectExternalDependencies(
  assets: CapturedAsset[],
  targetOrigin: string
): string[] {
  const found = new Set<string>();
  const urlPattern = /https?:\/\/([a-zA-Z0-9.-]+)/g;

  for (const asset of assets) {
    if (!asset.buffer) continue;
    if (asset.type !== "script" && asset.type !== "stylesheet") continue;

    const text = asset.buffer.toString("utf-8");
    for (const match of text.matchAll(urlPattern)) {
      const hostname = match[1];
      if (hostname && !targetOrigin.includes(hostname)) {
        found.add(hostname);
      }
    }
  }

  return Array.from(found).sort();
}
