/**
 * rscAssetScanner.ts
 *
 * Scans captured HTML for React Server Components (RSC) flight protocol
 * asset references that our Playwright network interceptor may have missed.
 *
 * Why RSC references can be missed
 * ----------------------------------
 * Next.js App Router uses a streaming RSC wire protocol. CSS and other assets
 * are injected into the page via inline <script> tags whose content is RSC
 * "flight data" rather than executable JavaScript:
 *
 *   self.__next_f.push([1, ":HL[\"/_next/static/css/1f6b83ea701bdbcc.css\",\"style\"]"])
 *
 * The `:HL[...]` directive is a "preload hint" baked into the RSC payload.
 * Our Playwright interceptor attaches at session start and captures all HTTP
 * responses reliably — but a CSS file may have been preloaded during an
 * earlier DNS preflight or HTTP/2 server push before the interceptor was
 * active, or the RSC payload may reference a CSS file whose only fetch was
 * deduped by the browser's preload scanner before our handler ran. The result:
 * `capture.assets` may not contain the CSS file even though a reference to it
 * exists in the captured HTML.
 *
 * The fix
 * --------
 * This module scans each rendered HTML string for `:HL[...]` patterns, extracts
 * the referenced URLs, and returns any that are absent from the current asset
 * list. The caller (writeRunMode / assembleRunMode) can then fetch those URLs
 * directly and add them to the asset table before path mapping runs.
 *
 * Supported RSC HL directive forms (all observed in production Next.js sites):
 *   :HL["/_next/static/css/hash.css","style"]
 *   :HL["/_next/static/chunks/main.js","script"]
 *   :HL["/fonts/Inter.woff2","font"]
 */

/**
 * Represents a single asset reference extracted from RSC flight data.
 */
export interface RscAssetRef {
  /** The absolute URL of the referenced asset. */
  url: string;
  /** The hint type from the RSC directive ("style", "script", "font", etc.) */
  hintType: string;
}

/**
 * Scans an HTML string for RSC flight protocol preload hint directives
 * (`:HL[...]`) and returns references to assets that are NOT already
 * present in `existingAssetUrls`.
 *
 * This function is intentionally a pure scanner — it does not fetch anything.
 * Fetching is the caller's responsibility so that network logic stays in one
 * place and this module remains trivially testable.
 *
 * @param html               Rendered HTML from a captured page
 * @param existingAssetUrls  Set of URLs already present in capture.assets
 * @param originUrl          The captured site origin (e.g. "https://example.com"),
 *                           used to resolve root-relative paths to absolute URLs
 * @returns Array of missing asset references the caller should fetch
 */
export function scanRscFlightReferences(
  html: string,
  existingAssetUrls: Set<string>,
  originUrl: string
): RscAssetRef[] {
  const missing: RscAssetRef[] = [];
  const seen = new Set<string>(); // dedup within this scan pass

  // Match all inline <script> tags' content. RSC flight data always lives
  // inside a <script> tag (either a self.__next_f.push call or an inline
  // block), never in an external .js file at this stage.
  //
  // We use a simple regex over the raw HTML because:
  //   1. We only need to find the small `:HL[...]` sub-strings, not parse HTML.
  //   2. The flight data format is tightly specified by the React team and
  //      has not changed the HL directive shape across Next.js 13–15.
  //   3. A full HTML parse would add a dependency and slow the assemble stage.
  const scriptContentPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  // The RSC flight data is a JSON-encoded string pushed into self.__next_f.
  // Inside that JSON, quote characters are escaped as \", which appears in
  // the raw HTML as the literal two-character sequence backslash-doublequote.
  // We need to match BOTH the plain-quote form (when the outer container is a
  // bare JS string) and the escaped-quote form (when the script content is a
  // JSON-encoded string, which is the normal Playwright capture).
  //
  // Strategy: match the opening \\?" then capture characters until we hit
  // the same closing \\?" pattern. Using a non-greedy match up to the
  // closing delimiter keeps us from eating into the next HL entry.
  //
  //   :HL[  opening-quote  (url)  closing-quote  ,  opening-quote  (type)  closing-quote  ]
  // where opening/closing-quote is optionally-backslash-escaped double-quote.
  const hlPattern = /:HL\[\\?"(.*?)\\?",\s*\\?"(.*?)\\?"\]/g;

  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptContentPattern.exec(html)) !== null) {
    const scriptContent = scriptMatch[1];
    if (!scriptContent) continue;

    // Only bother with scripts that contain RSC flight data — skip
    // ordinary analytics/hydration scripts for performance.
    if (!scriptContent.includes(":HL[") && !scriptContent.includes("__next_f")) {
      continue;
    }

    let hlMatch: RegExpExecArray | null;
    // Reset lastIndex since we're reusing the pattern across loop iterations
    hlPattern.lastIndex = 0;

    while ((hlMatch = hlPattern.exec(scriptContent)) !== null) {
      const rawPath = hlMatch[1];
      const hintType = hlMatch[2];
      if (!rawPath || !hintType) continue;

      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(rawPath, originUrl).href;
      } catch {
        // Unparseable path — skip rather than crash
        continue;
      }

      // Skip if we already have this asset or already found it in this scan
      if (existingAssetUrls.has(absoluteUrl) || seen.has(absoluteUrl)) continue;

      seen.add(absoluteUrl);
      missing.push({ url: absoluteUrl, hintType });
    }
  }

  return missing;
}

/**
 * Scans HTML for <link href="..."> and <script src="..."> references to
 * same-origin assets that are NOT already present in `existingAssetUrls`.
 *
 * This catches assets that appear only in plain HTML link/script tags —
 * not via RSC flight data — and that the Playwright network interceptor
 * may have missed (e.g. preloaded before the interceptor attached, or
 * referenced in a viewport that wasn't fully crawled).
 *
 * Only same-origin URLs are returned — cross-origin links are left as-is
 * since we can't and shouldn't try to capture third-party assets.
 */
export interface HtmlAssetRef {
  url: string;
  /** "stylesheet", "script", "font", "image", or "other" */
  resourceType: string;
}

export function scanHtmlLinkReferences(
  html: string,
  existingAssetUrls: Set<string>,
  originUrl: string
): HtmlAssetRef[] {
  const missing: HtmlAssetRef[] = [];
  const seen = new Set<string>();
  const origin = new URL(originUrl).origin;

  function process(rawHref: string, resourceType: string): void {
    if (!rawHref || rawHref.startsWith("data:") || rawHref.startsWith("#")) return;
    let absolute: string;
    try {
      absolute = new URL(rawHref, originUrl).href;
    } catch { return; }

    // Only same-origin assets — we can't fetch third-party URLs reliably
    if (!absolute.startsWith(origin)) return;
    if (existingAssetUrls.has(absolute) || seen.has(absolute)) return;

    seen.add(absolute);
    missing.push({ url: absolute, resourceType });
  }

  // <link rel="stylesheet" href="..."> and <link rel="preload" href="...">
  const linkPattern = /<link\s[^>]*>/gi;
  const hrefPattern = /href\s*=\s*["']([^"']+)["']/i;
  const relPattern  = /rel\s*=\s*["']([^"']+)["']/i;
  const asPattern   = /as\s*=\s*["']([^"']+)["']/i;

  let m: RegExpExecArray | null;
  while ((m = linkPattern.exec(html)) !== null) {
    const tag = m[0];
    const hrefMatch = hrefPattern.exec(tag);
    if (!hrefMatch?.[1]) continue;
    const rel = relPattern.exec(tag)?.[1] ?? "";
    const as  = asPattern.exec(tag)?.[1] ?? "";
    // Only care about stylesheet, preload, modulepreload — not prefetch/icon/manifest
    if (!/(stylesheet|preload|modulepreload)/.test(rel)) continue;
    const resourceType = as || (rel === "stylesheet" ? "stylesheet" : "other");
    process(hrefMatch[1], resourceType);
  }

  // <script src="..."> — external script tags only (not inline)
  const scriptPattern = /<script\s[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = scriptPattern.exec(html)) !== null) {
    if (m[1]) process(m[1], "script");
  }

  return missing;
}

/**
 * Scans captured JS assets for webpack chunk manifests and returns URLs
 * for any chunks that are registered in the manifest but not present in
 * the captured asset set.
 *
 * Why this is needed
 * ------------------
 * Next.js (and webpack generally) generates a chunk manifest inside the
 * webpack runtime bundle (typically webpack-<hash>.js). This manifest maps
 * chunk IDs to their filenames, e.g.:
 *   {812: "812.d20a89a90ccd58c4", 834: "834-ec7b1d4604495966", ...}
 *
 * The browser only fetches a chunk when it's actually needed (lazy import).
 * During our Playwright capture we only visit a few pages, so chunks for
 * routes we didn't visit are never requested — the network interceptor
 * never sees them and they're absent from capture.assets.
 *
 * The fix: extract the manifest from the webpack runtime bundle, compute
 * the full URL for each chunk, and return any that are missing so the
 * caller can fetch them directly during assembly.
 *
 * @param assets         The full list of captured assets
 * @param existingUrls   Set of already-captured asset URLs
 * @param originUrl      The site origin (e.g. "https://example.com")
 */
export interface MissingChunkRef {
  url: string;
}

export function scanMissingWebpackChunks(
  assets: import("../types/index.js").CapturedAsset[],
  existingUrls: Set<string>,
  originUrl: string
): MissingChunkRef[] {
  const missing: MissingChunkRef[] = [];
  const seen = new Set<string>();

  // Find all captured JS files — the webpack runtime is usually named
  // webpack-<hash>.js and is one of the smaller script files.
  const scriptAssets = assets.filter(
    (a) => a.type === "script" && a.buffer && a.url.includes("_next/static")
  );

  for (const asset of scriptAssets) {
    const js = asset.buffer!.toString("utf-8");

    // The webpack chunk manifest appears in several forms across Next.js versions.
    // We look for the most common patterns:
    //
    // Pattern 1 (Next.js 13-14 webpack runtime):
    //   {812:"812.d20a89a90ccd58c4",834:"834-ec7b1d4604495966",...}
    //
    // Pattern 2 (numeric key, hash value):
    //   e[812]="812.d20a89a90ccd58c4.js"
    //
    // We extract <chunkId>:<filename> pairs and construct the full URL.
    const chunkDir = deriveChunkDir(asset.url);
    if (!chunkDir) continue;

    // Match chunk manifest object literals: digits:"filename-hash" pairs
    const manifestPattern = /\b(\d{2,4})\s*:\s*["']([a-f0-9\-\.]+)["']/g;
    let m: RegExpExecArray | null;

    while ((m = manifestPattern.exec(js)) !== null) {
      const filename = m[2];
      if (!filename) continue;

      // Normalise: add .js if missing
      const jsFilename = filename.endsWith(".js") ? filename : `${filename}.js`;

      // Construct the absolute URL for this chunk
      const chunkUrl = `${originUrl.replace(/\/$/, "")}${chunkDir}/${jsFilename}`;

      if (existingUrls.has(chunkUrl) || seen.has(chunkUrl)) continue;

      // Quick sanity check: skip if it looks like a CSS or non-JS file
      if (!jsFilename.endsWith(".js")) continue;

      seen.add(chunkUrl);
      missing.push({ url: chunkUrl });
    }
  }

  return missing;
}

/**
 * Derives the chunk directory path from a webpack asset URL.
 * e.g. "https://example.com/_next/static/chunks/webpack-abc123.js"
 *   → "/_next/static/chunks"
 */
function deriveChunkDir(assetUrl: string): string | null {
  try {
    const { pathname } = new URL(assetUrl);
    const lastSlash = pathname.lastIndexOf("/");
    if (lastSlash === -1) return null;
    return pathname.slice(0, lastSlash);
  } catch {
    return null;
  }
}

/**
 * Maps a Content-Type header string to a CapturedAsset AssetType.
 */
export function contentTypeToAssetType(contentType: string): import("../types/index.js").AssetType {
  if (contentType.includes("text/css"))           return "stylesheet";
  if (contentType.includes("javascript"))         return "script";
  if (contentType.includes("font"))               return "font";
  if (contentType.startsWith("image/"))           return "image";
  if (contentType.includes("text/html"))          return "document";
  return "other";
}