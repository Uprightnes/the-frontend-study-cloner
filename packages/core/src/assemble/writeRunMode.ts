import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CaptureResult, CapturedAsset, AssembleResult } from "../types/index.js";
import { buildPathMappings, type PathMapping } from "./pathMapper.js";
import { rewriteHtmlReferences, rewriteCssReferences, rewriteJsStringLiterals } from "./rewriteReferences.js";
import { synthesizeDirectImageAssets, rewriteNextImageUrls, scanMissingNextImageAssets } from "./nextImageDecoder.js";
import { scanRscFlightReferences, scanHtmlLinkReferences, contentTypeToAssetType, scanMissingWebpackChunks } from "./rscAssetScanner.js";
import { bundleGoogleFonts, isGoogleFontsCssUrl } from "./googleFonts.js";

import posixPath from "node:path/posix";

/**
 * Creates a directory, handling the case where a FILE (not a directory)
 * already exists at the target path. This happens when a previous run or
 * the RSC asset writer placed a file called e.g. "salaries" (RSC JSON data)
 * at the path where we now need to create "salaries/" (a directory to hold
 * "salaries/index.html"). mkdir -p with { recursive: true } still throws
 * EEXIST when the path exists as a file rather than a directory.
 */
async function safeMkdir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") {
      // A file exists where we need a directory — remove it and retry
      await rm(dirPath, { recursive: true, force: true });
      await mkdir(dirPath, { recursive: true });
    } else {
      throw err;
    }
  }
}

/**
 * Writes data to a file, handling the case where a stale directory exists
 * at the target path (EISDIR). This happens when a previous run wrote
 * e.g. `salaries/index.html` but the current run is trying to write
 * `salaries` as a file, or vice versa. We remove the conflicting
 * directory before writing.
 */
async function safeWriteFile(fullPath: string, data: string | Buffer): Promise<void> {
  try {
    await writeFile(fullPath, data);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EISDIR") {
      // A directory exists where we want to write a file — remove it
      await rm(fullPath, { recursive: true, force: true });
      await writeFile(fullPath, data);
    } else {
      throw err;
    }
  }
}
function relativeFromDoc(documentLocalPath: string, targetLocalPath: string): string {
  const rel = posixPath.relative(posixPath.dirname(documentLocalPath), targetLocalPath);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Scans HTML for <video poster="..."> attribute values and returns their
 * absolute URLs. These are often not fetched by the browser network
 * interceptor because the browser defers poster loading until the video
 * element enters the viewport.
 */
function extractVideoPosterUrls(html: string, originUrl: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const pattern = /poster\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    if (!m[1]) continue;
    try {
      const absolute = new URL(m[1], originUrl).href;
      if (!seen.has(absolute)) {
        seen.add(absolute);
        urls.push(absolute);
      }
    } catch { /* skip malformed */ }
  }
  return urls;
}

/**
 * Synthesizes a CapturedAsset-shaped entry for each distinct crawled page
 * URL so that buildPathMappings can assign it a local path exactly like
 * any other resource. This is necessary because `capture.pages` (the
 * rendered DOM + styles per page/viewport) and `capture.assets` (network
 * resources discovered during capture) are kept as separate lists in
 * CaptureResult — but path mapping needs ALL url->localPath assignments
 * in one table, or else an `<a href="https://site.com/about">` link on
 * the homepage has nothing to resolve against when rewriteHtmlReferences
 * looks it up, since "/about" the page was never registered as a
 * mappable target. Without this, internal page-to-page navigation links
 * silently fall back to their original absolute URL (still functionally
 * correct online, but defeats the purpose of producing a self-contained
 * local copy where clicking "About" opens the local about.html).
 */
function buildDocumentAssetStubs(capture: CaptureResult): CapturedAsset[] {
  const distinctPageUrls = new Set(capture.pages.map((p) => p.url));
  return Array.from(distinctPageUrls).map((url) => ({
    url,
    type: "document" as const,
    status: 200,
    discoveredViaInteraction: false,
    // No buffer needed — writeHtmlDocument writes page.renderedHtml
    // directly, not via this stub's (nonexistent) buffer. This stub
    // exists purely to claim a slot in the path-mapping table.
  }));
}

/**
 * Writes a single captured page's rendered HTML to disk. Each page in
 * `capture.pages` represents one viewport capture of (possibly) the same
 * URL — we only need to write the document once, so the caller is
 * expected to have already deduplicated by URL before calling this (see
 * writeRunMode below, which picks the desktop viewport's HTML as the
 * canonical document body).
 */
async function writeHtmlDocument(
  outputDir: string,
  documentLocalPath: string,
  renderedHtml: string,
  mappings: Map<string, PathMapping>,
  originUrl: string,
  googleFontsCssMap: Map<string, string>
): Promise<void> {
  // Step 1: rewrite normal href/src/srcset/poster attributes
  let rewritten = rewriteHtmlReferences(renderedHtml, documentLocalPath, mappings, originUrl);

  // Step 2: rewrite Next.js Image Optimization API URLs (/_next/image?url=...)
  rewritten = rewriteNextImageUrls(rewritten, documentLocalPath, originUrl, mappings);

  // Step 3: rewrite Google Fonts <link> hrefs to local CSS paths
  for (const [googleUrl, localCssPath] of googleFontsCssMap) {
    // Compute document-relative path to the local font CSS
    const rel = relativeFromDoc(documentLocalPath, localCssPath);
    // Replace the href attribute value — use a targeted replace to avoid
    // touching other attributes on the same <link> tag
    rewritten = rewritten.replaceAll(googleUrl, rel);
  }

  const fullPath = path.join(outputDir, documentLocalPath);
  await safeMkdir(path.dirname(fullPath));
  await safeWriteFile(fullPath, rewritten);
}

async function writeAsset(
  outputDir: string,
  asset: CapturedAsset,
  mapping: PathMapping,
  mappings: Map<string, PathMapping>,
  originUrl: string
): Promise<void> {
  if (!asset.buffer) return; // failed/unavailable fetch — nothing to write

  const fullPath = path.join(outputDir, mapping.localPath);
  await safeMkdir(path.dirname(fullPath));

  if (asset.type === "stylesheet") {
    const css = asset.buffer.toString("utf-8");
    const rewritten = rewriteCssReferences(css, mapping.localPath, mappings, originUrl);
    await safeWriteFile(fullPath, rewritten);
    return;
  }

  if (asset.type === "script") {
    const js = asset.buffer.toString("utf-8");
    const { rewritten } = rewriteJsStringLiterals(js, mappings, mapping.localPath);
    await safeWriteFile(fullPath, rewritten);
    return;
  }

  // Binary assets (images, fonts, media) are written byte-for-byte,
  // untouched — there's no text-level rewriting to do, and per the PRD,
  // these should never be "optimized" in a way that risks corrupting
  // them during Run mode assembly. (Image optimization, if added later,
  // belongs in Study mode as an explicit, opt-in transform.)
  await safeWriteFile(fullPath, asset.buffer);
}

/**
 * Maps an RSC HL hint type ("style", "script", "font", etc.) plus the
 * Content-Type header from the fetch response to a CapturedAsset AssetType.
 * Falls back to "other" for unknown combinations.
 */
function rscHintTypeToAssetType(
  hintType: string,
  contentType: string
): CapturedAsset["type"] {
  switch (hintType.toLowerCase()) {
    case "style":
      return "stylesheet";
    case "script":
      return "script";
    case "font":
      return "font";
    case "image":
      return "image";
    default:
      // Fall back to Content-Type sniffing
      if (contentType.includes("text/css")) return "stylesheet";
      if (contentType.includes("javascript")) return "script";
      if (contentType.includes("font")) return "font";
      if (contentType.startsWith("image/")) return "image";
      return "other";
  }
}

/**
 * Returns the pathname-only key for a URL, used to match RSC fetch requests
 * (which carry ?_rsc=<hash> query params) against page URLs (which have no
 * query string). We strip query strings entirely for this comparison because
 * Next.js RSC fetches hit the same pathname as the page URL but with a random
 * _rsc query parameter added each time.
 *
 * We do NOT use normalizeUrlForDedupe here because that preserves query strings.
 */
function pagePathKey(url: string): string {
  try {
    const u = new URL(url);
    // Use origin + pathname only, no query string, no hash
    let key = u.origin + u.pathname;
    // Strip trailing slash (except for root /)
    if (key.endsWith("/") && u.pathname !== "/") {
      key = key.slice(0, -1);
    }
    return key;
  } catch {
    return url;
  }
}

export interface WriteRunModeOptions {
  outputDir: string;
}

/**
 * Top-level Run-mode file writer. Takes a completed CaptureResult and
 * produces the actual dist-style output directory: rewritten HTML
 * documents, rewritten CSS/JS, and untouched binary assets, all at the
 * local paths computed by buildPathMappings.
 */
export async function writeRunMode(
  capture: CaptureResult,
  options: WriteRunModeOptions
): Promise<AssembleResult> {
  const warnings: string[] = [];
  const filesWritten: string[] = [];

  // ── Bug 3 fix: RSC flight asset scanner ──────────────────────────────────
  // Next.js App Router injects CSS/script preload hints inside RSC flight data
  // (self.__next_f.push([1, ":HL[\"/_next/static/css/hash.css\",\"style\"]"]))
  // rather than via <link> elements, so our network interceptor may not have
  // captured every referenced asset. Scan all rendered HTML pages for missing
  // HL directives, fetch them, and add them to the asset list before mapping.
  const existingAssetUrls = new Set(capture.assets.map((a) => a.url));
  const allRenderedHtml = capture.pages.map((p) => p.renderedHtml).join("\n");
  const missingRscRefs = scanRscFlightReferences(allRenderedHtml, existingAssetUrls, capture.targetUrl);

  const fetchedRscAssets: CapturedAsset[] = [];
  for (const ref of missingRscRefs) {
    try {
      const response = await fetch(ref.url);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get("content-type") ?? "";
        const type = rscHintTypeToAssetType(ref.hintType, contentType);
        fetchedRscAssets.push({
          url: ref.url,
          type,
          buffer,
          status: response.status,
          discoveredViaInteraction: false,
        });
      } else {
        warnings.push(`RSC-referenced asset not fetchable (HTTP ${response.status}): ${ref.url}`);
      }
    } catch (err) {
      warnings.push(`RSC-referenced asset fetch failed: ${ref.url} — ${String(err)}`);
    }
  }

  // ── Supplemental: HTML <link> asset scanner ──────────────────────────────
  // Some CSS/font/script assets appear only in <link rel="preload"> or
  // <link rel="stylesheet"> tags injected directly into the HTML by Next.js,
  // without a corresponding RSC flight HL directive. The RSC scanner above
  // won't find these. Scan all <link href="..."> and <script src="...">
  // references in the rendered HTML, and fetch any that aren't already in
  // the capture or fetched via RSC above.
  const afterRscUrls = new Set([
    ...existingAssetUrls,
    ...fetchedRscAssets.map((a) => a.url),
  ]);
  const missingLinkRefs = scanHtmlLinkReferences(allRenderedHtml, afterRscUrls, capture.targetUrl);

  const fetchedLinkAssets: CapturedAsset[] = [];
  for (const ref of missingLinkRefs) {
    try {
      const response = await fetch(ref.url);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get("content-type") ?? "";
        const type = contentTypeToAssetType(contentType);
        fetchedLinkAssets.push({
          url: ref.url,
          type,
          buffer,
          status: response.status,
          discoveredViaInteraction: false,
        });
      } else {
        warnings.push(`HTML-linked asset not fetchable (HTTP ${response.status}): ${ref.url}`);
      }
    } catch (err) {
      warnings.push(`HTML-linked asset fetch failed: ${ref.url} — ${String(err)}`);
    }
  }
  // ── Webpack chunk manifest scanner ───────────────────────────────────────
  // Next.js lazy-loads JS chunks on demand — chunks for routes not visited
  // during capture are never requested by Playwright and are absent from
  // capture.assets. Scan the webpack runtime bundle's chunk manifest for
  // all registered chunk IDs, compute their URLs, and fetch any that are
  // missing so the output is complete and hydration doesn't fail.
  const afterLinkUrls = new Set([
    ...existingAssetUrls,
    ...fetchedRscAssets.map((a) => a.url),
    ...fetchedLinkAssets.map((a) => a.url),
  ]);
  const missingChunks = scanMissingWebpackChunks(
    capture.assets,
    afterLinkUrls,
    capture.targetUrl
  );

  const fetchedChunkAssets: CapturedAsset[] = [];
  for (const chunk of missingChunks) {
    try {
      const response = await fetch(chunk.url);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        fetchedChunkAssets.push({
          url: chunk.url,
          type: "script",
          buffer,
          status: response.status,
          discoveredViaInteraction: false,
        });
      }
      // 404s are silent — some manifest entries are for chunks that are
      // listed but never actually needed (dead code, removed routes).
    } catch {
      // Network failure fetching a chunk — skip rather than crash.
    }
  }
  // Sites using fonts.googleapis.com get a CSS file that in turn references
  // fonts.gstatic.com for the actual .woff2 files. Download both and rewrite
  // the CSS so the output works offline without depending on Google's CDN.
  const googleFontsResult = await bundleGoogleFonts(
    capture.assets,
    allRenderedHtml,
    existingAssetUrls
  );
  for (const w of googleFontsResult.warnings) warnings.push(w);

  // ── Video poster image capture ───────────────────────────────────────────
  // <video poster="..."> attributes are often not fetched by the browser
  // until the video element enters the viewport. Scan for them and fetch.
  const videoPosterUrls = extractVideoPosterUrls(allRenderedHtml, capture.targetUrl);
  const fetchedPosterAssets: CapturedAsset[] = [];
  for (const posterUrl of videoPosterUrls) {
    if (existingAssetUrls.has(posterUrl)) continue;
    try {
      const response = await fetch(posterUrl);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        fetchedPosterAssets.push({
          url: posterUrl,
          type: "image",
          buffer,
          status: response.status,
          discoveredViaInteraction: false,
        });
      } else {
        warnings.push(`Video poster not fetchable (HTTP ${response.status}): ${posterUrl}`);
      }
    } catch (err) {
      warnings.push(`Video poster fetch failed: ${posterUrl} — ${String(err)}`);
    }
  }

  // /_next/image?url=... API URLs are runtime endpoints, not static files.
  // Our interceptor captured their response bytes under the API URL, but a
  // static server cannot serve query-string paths from disk. Synthesize
  // CapturedAsset entries at the decoded underlying image URLs instead, so
  // they land at proper paths (e.g. images/hero.png) and the HTML rewriter
  // can reference them correctly.
  const synthesizedImageAssets = synthesizeDirectImageAssets(capture.assets, capture.targetUrl);

  // Some images referenced via /_next/image?url=... in the HTML were never
  // captured by Playwright at all — lazy-loaded thumbnails, below-the-fold
  // images, or images inside JS interactions. Scan the HTML for any decoded
  // URLs not already covered by synthesizedImageAssets, and fetch them directly
  // from the CDN / same-origin server.
  const alreadySynthesizedUrls = new Set(synthesizedImageAssets.map((a) => a.url));
  const missingImageUrls = scanMissingNextImageAssets(
    allRenderedHtml,
    alreadySynthesizedUrls,
    capture.targetUrl
  );

  const fetchedImageAssets: CapturedAsset[] = [];
  for (const imageUrl of missingImageUrls) {
    try {
      const response = await fetch(imageUrl);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        fetchedImageAssets.push({
          url: imageUrl,
          type: "image",
          buffer,
          status: response.status,
          discoveredViaInteraction: false,
        });
      } else {
        warnings.push(`Next.js image not fetchable (HTTP ${response.status}): ${imageUrl}`);
      }
    } catch (err) {
      warnings.push(`Next.js image fetch failed: ${imageUrl} — ${String(err)}`);
    }
  }

  // ── Assemble the full asset list and build the path mapping table ─────────
  // Order: document stubs first (for dedup priority), then real captured
  // assets, then RSC-fetched supplements, then synthesized image assets.
  // Synthesized images come last so any real capture of the decoded URL
  // already holds its slot.
  //
  // IMPORTANT: capture.assets contains document-type entries for every
  // navigated page URL (the crawler records both the page snapshot in
  // capture.pages AND an asset entry in capture.assets). If we pass both
  // the stub and the capture.assets document entry for the same URL into
  // buildPathMappings, the second registration triggers hash-suffix collision
  // resolution, producing "index-9f6bde.html" instead of "index.html".
  // We deduplicate by URL here, keeping the first occurrence (the stub),
  // so each URL claims its clean path exactly once.
  // Build a pathname-only key set for filtering RSC fetch assets.
  // Next.js RSC fetches hit the same page pathname but add ?_rsc=<random>
  // query params. normalizeUrlForDedupe preserves query strings, so those
  // variants would slip through. pagePathKey strips query strings entirely,
  // matching /about?_rsc=xyz → /about → caught correctly.
  const normalizedPageUrls = new Set(
    capture.pages.map((p) => pagePathKey(p.url))
  );

  const seenUrls = new Set<string>();
  const allAssets: CapturedAsset[] = [];
  for (const asset of [
    ...buildDocumentAssetStubs(capture),
    ...capture.assets,
    ...fetchedRscAssets,
    ...fetchedLinkAssets,
    ...fetchedChunkAssets,
    ...googleFontsResult.assets,
    ...fetchedPosterAssets,
    ...synthesizedImageAssets,
    ...fetchedImageAssets,
  ]) {
    // Skip non-document assets whose pathname matches a page URL.
    // Uses pagePathKey (origin+pathname only) so that RSC fetch variants
    // like /about?_rsc=<hash> are caught as matching the /about page.
    if (asset.type !== "document" && normalizedPageUrls.has(pagePathKey(asset.url))) {
      continue;
    }
    if (!seenUrls.has(asset.url)) {
      seenUrls.add(asset.url);
      allAssets.push(asset);
    }
  }

  // preserveStructure: true keeps every asset at its original server-relative
  // path (e.g. /_next/static/css/hash.css → _next/static/css/hash.css).
  // This is essential for Next.js, whose minified chunk loader contains
  // hardcoded "/_next/static/" string literals that we cannot safely rewrite
  // inside JS bundles. With a preserved structure the browser resolves those
  // references correctly when the output is served from its root directory.
  const mappings = buildPathMappings(allAssets, { preserveStructure: true });

  // Pick one canonical HTML document per distinct page URL. Multiple
  // viewport captures of the same URL share one on-disk file in Run mode
  // — Run mode's job is "a working copy", not "every responsive
  // variant side by side". We prefer the desktop viewport's DOM as the
  // canonical version since it's typically the most complete (fewer
  // hidden-on-mobile elements), falling back to whichever was captured
  // first if no "desktop" viewport name is present.
  const canonicalPages = new Map<string, (typeof capture.pages)[number]>();
  for (const page of capture.pages) {
    const existing = canonicalPages.get(page.url);
    if (!existing || page.viewport.name === "desktop") {
      canonicalPages.set(page.url, page);
    }
  }

  // ── Phase 1: Pre-create all page directories ─────────────────────────────
  // Do this BEFORE writing any assets. Without this, writeAsset for an RSC
  // JSON file at "https://salaryindex.ng/about?_rsc=xyz" could write a file
  // named "about" at the output root before we try to mkdir("about/") for
  // the HTML page, causing EEXIST. By creating all page directories first,
  // any later attempt to write a file at "about" is handled by safeWriteFile
  // which removes the conflicting path.
  for (const [url] of canonicalPages) {
    const documentMapping = mappings.get(url);
    const documentLocalPath = documentMapping?.localPath ?? "index.html";
    const fullDir = path.join(options.outputDir, path.dirname(documentLocalPath));
    await safeMkdir(fullDir);
  }

  // ── Phase 2: Write all HTML documents ────────────────────────────────────
  for (const [url, page] of canonicalPages) {
    const documentMapping = mappings.get(url);
    const documentLocalPath = documentMapping?.localPath ?? "index.html";
    await writeHtmlDocument(
      options.outputDir,
      documentLocalPath,
      page.renderedHtml,
      mappings,
      capture.targetUrl,
      googleFontsResult.cssUrlToLocalPath
    );
    filesWritten.push(documentLocalPath);
  }

  // ── Phase 3: Write all non-document assets ────────────────────────────────
  // Page directories are guaranteed to exist from Phase 1, so no EEXIST
  // conflicts are possible between RSC data files and page directories.
  const writableAssets = allAssets.filter((a) => a.type !== "document");
  const writtenLocalPaths = new Set<string>();

  for (const asset of writableAssets) {
    const mapping = mappings.get(asset.url);
    if (!mapping) continue;

    // Skip duplicate local paths — can happen when a synthesized image URL
    // collides with an already-written real asset at the same decoded path.
    if (writtenLocalPaths.has(mapping.localPath)) continue;

    if (!asset.buffer) {
      warnings.push(`Asset unavailable, skipped: ${asset.url} (HTTP ${asset.status})`);
      continue;
    }

    await writeAsset(options.outputDir, asset, mapping, mappings, capture.targetUrl);
    filesWritten.push(mapping.localPath);
    writtenLocalPaths.add(mapping.localPath);
  }

  // ── Post-assembly validation ──────────────────────────────────────────────
  // Verify that every captured page has a corresponding HTML file on disk.
  // If any are missing (due to mkdir failure, write error, etc.), add a clear
  // warning so the user knows which pages won't work rather than silently
  // getting the homepage SPA fallback for those routes.
  for (const [url] of canonicalPages) {
    const documentMapping = mappings.get(url);
    const documentLocalPath = documentMapping?.localPath ?? "index.html";
    const fullPath = path.join(options.outputDir, documentLocalPath);
    try {
      await stat(fullPath);
    } catch {
      warnings.push(
        `Page HTML missing from output: ${documentLocalPath} (source: ${url}) — ` +
        `navigating to this page will show the homepage instead.`
      );
    }
  }

  return { outputDir: options.outputDir, filesWritten, warnings };
}
