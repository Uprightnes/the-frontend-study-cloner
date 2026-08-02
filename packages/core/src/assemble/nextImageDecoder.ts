/**
 * nextImageDecoder.ts
 *
 * Handles Next.js Image Optimization API URLs, which take the form:
 *   /_next/image?url=%2Fimages%2Fhero.png&w=1200&q=75
 *   /_next/image?url=https%3A%2F%2Fcdn.sanity.io%2F...&w=3840&q=80
 *
 * These are server-side endpoints, not static files. Our network interceptor
 * captures the HTTP response bytes (already-resized image data) keyed under
 * the full API URL including query string. But there is no static file at
 * that path, so a local static server can never resolve them.
 *
 * The fix has two parts:
 *
 * 1. synthesizeDirectImageAssets — scans captured assets for /_next/image?url=...
 *    entries, decodes the `url` query parameter to find the underlying image
 *    path, keeps the highest-quality (largest buffer) capture for each decoded
 *    URL, and returns synthesized CapturedAsset entries keyed at the decoded URL.
 *    These synthesized assets are added to the mapping table and written to disk
 *    at the decoded path (e.g. images/hero.png), where a preserveStructure Run
 *    mode layout will find them correctly.
 *
 * 2. rewriteNextImageUrls — rewrites every /_next/image?url=... occurrence in
 *    HTML src and srcset attributes to the corresponding decoded local path, so
 *    `<img src="/_next/image?url=%2Fimages%2Fhero.png&w=1200&q=75">` becomes
 *    `<img src="images/hero.png">` (relative to the document's own location).
 *
 * Why this approach and not storing images at the API URL path?
 * A static file server cannot serve query-string-parametrized paths from disk.
 * The decoded path is the actual canonical identity of the image; the API URL
 * is just a runtime transformation handle. Storing at the decoded path also
 * means the image is deduplicated once across all the width variants.
 */

import type { CapturedAsset } from "../types/index.js";
import type { PathMapping } from "./pathMapper.js";
import path from "node:path";

/**
 * Returns true if the given URL string (absolute OR root-relative) is a
 * Next.js Image Optimization API URL.
 *
 * Accepts root-relative paths (e.g. `/_next/image?url=...`) because that is
 * what appears in HTML `src` attribute values captured from the rendered DOM.
 * The `originUrl` base is used only to parse root-relative values — the
 * comparison is purely on `pathname` and `searchParams`, so passing any valid
 * origin string (e.g. "https://example.com") is fine even if the URL came
 * from a different origin.
 */
export function isNextImageUrl(url: string, originUrl = "https://placeholder.invalid"): boolean {
  try {
    const parsed = new URL(url, originUrl);
    return parsed.pathname === "/_next/image" && parsed.searchParams.has("url");
  } catch {
    return false;
  }
}

/**
 * Decodes a Next.js Image Optimization API URL (absolute or root-relative) to
 * the underlying image URL.
 * Returns null if the URL is not a valid /_next/image URL or has no `url` param.
 *
 * The `url` param can be:
 *   - A root-relative path: %2Fimages%2Fhero.png → /images/hero.png
 *   - An absolute URL:      https%3A%2F%2Fcdn.sanity.io%2F... → https://cdn.sanity.io/...
 *
 * Root-relative paths and the `url` parameter value are both resolved against
 * `originUrl` to produce a full absolute URL.
 */
export function decodeNextImageUrl(apiUrl: string, originUrl: string): string | null {
  try {
    const parsed = new URL(apiUrl, originUrl);
    if (parsed.pathname !== "/_next/image") return null;
    const rawParam = parsed.searchParams.get("url");
    if (!rawParam) return null;
    // new URL handles both absolute URLs and root-relative paths
    return new URL(rawParam, originUrl).href;
  } catch {
    return null;
  }
}

/**
 * Scans `assets` for Next.js Image Optimization API entries and produces
 * synthesized CapturedAsset records at the decoded image URLs.
 *
 * Multiple /_next/image requests for the same underlying image (different
 * widths/qualities) are deduplicated by keeping the buffer from the largest
 * captured response — a reasonable proxy for highest quality, since larger
 * images carry more pixel data. The caller should merge the returned array
 * into the asset list before building path mappings so the decoded images
 * are written to disk and included in the mapping table.
 *
 * @param assets    The full list of captured assets from CaptureResult.assets
 * @param originUrl The captured site's origin URL (e.g. "https://example.com")
 */
export function synthesizeDirectImageAssets(
  assets: CapturedAsset[],
  originUrl: string
): CapturedAsset[] {
  // Map from decoded image URL → best (largest-buffer) captured asset
  const best = new Map<string, CapturedAsset>();

  for (const asset of assets) {
    if (!isNextImageUrl(asset.url)) continue;
    if (!asset.buffer) continue;

    const decodedUrl = decodeNextImageUrl(asset.url, originUrl);
    if (!decodedUrl) continue;

    const existing = best.get(decodedUrl);
    if (!existing || asset.buffer.length > (existing.buffer?.length ?? 0)) {
      best.set(decodedUrl, asset);
    }
  }

  // Produce a synthesized CapturedAsset for each decoded URL, keyed by
  // the decoded URL rather than the original API URL. The buffer comes
  // from the best (largest) captured API response.
  const synthesized: CapturedAsset[] = [];
  for (const [decodedUrl, sourceAsset] of best) {
    synthesized.push({
      url: decodedUrl,
      type: "image",
      buffer: sourceAsset.buffer,
      status: sourceAsset.status,
      discoveredViaInteraction: sourceAsset.discoveredViaInteraction,
    });
  }

  return synthesized;
}

/**
 * Scans HTML for /_next/image?url=... src/srcset values whose decoded
 * underlying image URL is NOT already present in `existingDecodedUrls`.
 *
 * These are images that were referenced in the HTML but never captured by
 * the Playwright network interceptor — typically because they were lazy-loaded
 * below the fold, inside a JS interaction, or were only requested at a size/
 * quality that our interceptor missed. We return the list of decoded URLs to
 * fetch so the caller can add them to the asset table before mapping runs.
 *
 * We use the decoded URL (e.g. `https://cdn.sanity.io/images/hero.jpg`) rather
 * than the API URL because (a) that's what we need to fetch from the CDN
 * directly, and (b) we'd need the image at the decoded path on disk anyway.
 *
 * @param html                Rendered HTML string from a captured page
 * @param existingDecodedUrls Set of decoded image URLs already in the asset table
 * @param originUrl           The site origin, for resolving root-relative params
 */
export function scanMissingNextImageAssets(
  html: string,
  existingDecodedUrls: Set<string>,
  originUrl: string
): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();

  // Match src and srcset attribute values that contain /_next/image?url=...
  // We extract just the URL part and then decode it.
  const srcPattern = /src\s*=\s*["'](\/\_next\/image\?[^"']+)["']/gi;
  const srcsetPattern = /srcset\s*=\s*["']([^"']*\/\_next\/image\?[^"']+)["']/gi;

  function processApiUrl(raw: string): void {
    const trimmed = raw.trim();
    if (!isNextImageUrl(trimmed, originUrl)) return;
    const decoded = decodeNextImageUrl(trimmed, originUrl);
    if (!decoded) return;
    if (existingDecodedUrls.has(decoded) || seen.has(decoded)) return;
    seen.add(decoded);
    missing.push(decoded);
  }

  let m: RegExpExecArray | null;

  while ((m = srcPattern.exec(html)) !== null) {
    if (m[1]) processApiUrl(m[1]);
  }

  while ((m = srcsetPattern.exec(html)) !== null) {
    if (!m[1]) continue;
    // srcset is comma-separated "url descriptor" pairs
    for (const entry of m[1].split(",")) {
      const url = entry.trim().split(/\s+/)[0];
      if (url) processApiUrl(url);
    }
  }

  return missing;
}

/**
 * Computes a relative path from one local output path to another.
 * Always POSIX-style forward slashes, since this lands inside HTML.
 */
function relativeFrom(fromFile: string, toFile: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Rewrites every /_next/image?url=... occurrence in an HTML string to point
 * at the corresponding local decoded image path.
 *
 * Operates on both `src="..."` single-value attributes and `srcset="..."`
 * comma-separated descriptor lists. Each API URL is replaced with a
 * document-relative path looked up via `localPathFor`.
 *
 * If `localPathFor` returns null for a given decoded URL (e.g. the image was
 * not captured), the original API URL is left untouched rather than producing
 * a broken local reference.
 *
 * @param html            The rendered HTML string to rewrite
 * @param documentLocalPath  Unused (kept for API compatibility). Previously
 *                           used to compute document-relative paths; now
 *                           root-relative paths are used instead.
 * @param originUrl       The origin URL, used to decode root-relative /_next/image params
 * @param mappings        The full path-mapping table (including synthesized assets)
 */
export function rewriteNextImageUrls(
  html: string,
  documentLocalPath: string,
  originUrl: string,
  mappings: Map<string, PathMapping>
): string {
  /**
   * Given a single URL value from src or srcset, if it is a /_next/image URL
   * and we have a local mapping for its decoded counterpart, return the local
   * relative path. Otherwise return the original value unchanged.
   */
  function maybeRewrite(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!isNextImageUrl(trimmed, originUrl)) return rawUrl;

    const decodedUrl = decodeNextImageUrl(trimmed, originUrl);
    if (!decodedUrl) return rawUrl;

    const mapping = mappings.get(decodedUrl);
    if (!mapping) return rawUrl;

    // Root-relative so it works from any document depth including SPA fallback
    return "/" + mapping.localPath;
  }

  // Rewrite src="..." for /_next/image URLs. We target only the src attribute
  // here; plain href/poster attributes are handled by the main HTML rewriter
  // which runs before this function and won't have local mappings for
  // /_next/image?... keys (those API URLs are never registered in the table).
  let result = html.replace(
    /(src\s*=\s*)(["'])(\/\_next\/image\?[^"']*)\2/gi,
    (_full, attr, quote, value) => {
      const rewritten = maybeRewrite(value);
      return `${attr}${quote}${rewritten}${quote}`;
    }
  );

  // Rewrite srcset="..." which contains comma-separated "URL descriptor" pairs.
  // A Next.js <Image> component emits srcset entries like:
  //   /_next/image?url=%2Fimg.png&w=640&q=75 640w, /_next/image?url=%2Fimg.png&w=1280&q=75 1280w
  result = result.replace(
    /(srcset\s*=\s*)(["'])([^"']*\/\_next\/image\?[^"']*)\2/gi,
    (_full, attr, quote, value) => {
      const rewritten = value
        .split(",")
        .map((entry: string) => {
          const trimmed = entry.trim();
          const spaceIdx = trimmed.search(/\s/);
          if (spaceIdx === -1) {
            // No descriptor (just a URL), rewrite the whole entry
            return maybeRewrite(trimmed);
          }
          const url = trimmed.slice(0, spaceIdx);
          const descriptor = trimmed.slice(spaceIdx); // e.g. " 640w"
          return `${maybeRewrite(url)}${descriptor}`;
        })
        .join(", ");
      return `${attr}${quote}${rewritten}${quote}`;
    }
  );

  return result;
}
