import type { CapturedAsset, SourceMapFinding } from "../types/index.js";

/**
 * Matches both comment styles build tools use for this annotation:
 * JS: `//# sourceMappingURL=foo.js.map`
 * CSS: `/*# sourceMappingURL=foo.css.map *\/`
 * Both end in the same `sourceMappingURL=<value>` token, so one pattern
 * covers both — we don't need to distinguish comment syntax, just extract
 * the URL.
 */
const SOURCE_MAP_COMMENT = /sourceMappingURL=([^\s*]+)/;

/**
 * Scans captured JS/CSS assets for a sourceMappingURL comment, then
 * probes whether that .map file is actually fetchable (some sites
 * reference a map that 404s — pointless to report as a "finding").
 *
 * Inline (data: URL) source maps are intentionally skipped here: they
 * don't need a "fetchable" check since the map is already embedded in the
 * bundle text itself, and passing a data: URL through new URL(..., base)
 * would produce a nonsensical "resolved" URL. A future enhancement could
 * surface inline maps as a separate, always-confirmed finding; for now
 * they're simply not reported, which undercounts slightly rather than
 * misreporting.
 */
export async function detectSourceMaps(assets: CapturedAsset[]): Promise<SourceMapFinding[]> {
  const findings: SourceMapFinding[] = [];

  const candidates = assets.filter(
    (a) => (a.type === "script" || a.type === "stylesheet") && a.buffer
  );

  for (const asset of candidates) {
    const text = asset.buffer!.toString("utf-8");
    const match = text.match(SOURCE_MAP_COMMENT);
    const rawMapPath = match?.[1];
    if (!rawMapPath || rawMapPath.startsWith("data:")) continue;

    const mapUrl = new URL(rawMapPath, asset.url).href;
    const confirmed = await isMapFetchable(mapUrl);

    findings.push({ bundleUrl: asset.url, mapUrl, confirmed });
  }

  return findings;
}

async function isMapFetchable(mapUrl: string): Promise<boolean> {
  try {
    const res = await fetch(mapUrl, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}
