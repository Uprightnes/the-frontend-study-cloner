/**
 * googleFonts.ts
 *
 * Downloads Google Fonts CSS and the actual font files it references,
 * producing locally-served copies so the Run-mode output doesn't depend
 * on the live fonts.googleapis.com / fonts.gstatic.com CDN.
 *
 * Why this matters
 * ----------------
 * Sites using Google Fonts include a <link> like:
 *   <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700" rel="stylesheet">
 *
 * This URL returns a CSS file containing @font-face rules that point at
 * fonts.gstatic.com for the actual .woff2 files. Both requests go to
 * Google's CDN. In a local Run-mode output:
 *  - If the user is online, these still work (but defeat the "offline" goal)
 *  - If the user is offline, all custom fonts break and the site looks wrong
 *
 * The fix is to:
 *  1. Detect any https://fonts.googleapis.com/css* URLs in captured assets
 *     and in HTML <link> tags
 *  2. Fetch the CSS (with a desktop User-Agent so Google returns woff2)
 *  3. Parse the @font-face src: url(...) references from that CSS
 *  4. Fetch each .woff2 file
 *  5. Return synthesized CapturedAsset entries for both the CSS and font files
 *     at stable local paths (fonts/google/<family>/<file>)
 *
 * The CSS is also rewritten so its src: url() values point at the local
 * font files rather than fonts.gstatic.com.
 */

import type { CapturedAsset } from "../types/index.js";

const GOOGLE_FONTS_CSS_ORIGIN = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILE_ORIGIN = "https://fonts.gstatic.com";

// Fetch Google Fonts CSS with a modern desktop UA so Google returns
// woff2 format (which it only does for browsers it knows support it).
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Returns true if the URL is a Google Fonts CSS API endpoint.
 */
export function isGoogleFontsCssUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === GOOGLE_FONTS_CSS_ORIGIN && u.pathname.startsWith("/css");
  } catch {
    return false;
  }
}

/**
 * Returns true if the URL is a Google Fonts file (woff2, etc.).
 */
export function isGoogleFontsFileUrl(url: string): boolean {
  try {
    return new URL(url).origin === GOOGLE_FONTS_FILE_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Extracts all @font-face src: url("...") values from a Google Fonts
 * CSS string. Google Fonts CSS only uses url("...") with double quotes
 * inside @font-face blocks, so a targeted pattern is safe here.
 */
function extractFontFileUrls(css: string): string[] {
  const urls: string[] = [];
  // Match: src: url(https://fonts.gstatic.com/...) or url("...")
  const pattern = /url\(["']?(https:\/\/fonts\.gstatic\.com\/[^"')]+)["']?\)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(css)) !== null) {
    if (m[1]) urls.push(m[1]);
  }
  return [...new Set(urls)];
}

/**
 * Derives a stable local path for a Google Fonts file URL.
 * e.g. https://fonts.gstatic.com/s/inter/v13/abc123.woff2
 *   → fonts/google/s/inter/v13/abc123.woff2
 */
function localFontPath(url: string): string {
  const { pathname } = new URL(url);
  // Strip leading slash, prefix with fonts/google/
  return `fonts/google${pathname}`;
}

/**
 * Derives a stable local path for a Google Fonts CSS URL.
 * e.g. https://fonts.googleapis.com/css2?family=Inter:wght@400;700
 *   → fonts/google/css/inter-wght400-700.css
 * We use a hash of the full URL to avoid collisions between different
 * family combinations while keeping the name somewhat readable.
 */
function localCssPath(url: string): string {
  const { searchParams } = new URL(url);
  const family = searchParams.get("family") ?? "fonts";
  // Sanitize: replace anything not alphanumeric/hyphen with hyphen
  const safeName = family.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 60);
  return `fonts/google/css/${safeName}.css`;
}

export interface GoogleFontsBundle {
  /** Synthesized CapturedAsset entries for CSS + all font files */
  assets: CapturedAsset[];
  /**
   * Map from original Google Fonts CSS URL → local CSS path.
   * Used by the HTML rewriter to replace <link href="https://fonts.googleapis.com/...">
   * with the local CSS path.
   */
  cssUrlToLocalPath: Map<string, string>;
  warnings: string[];
}

/**
 * Discovers Google Fonts CSS URLs referenced in captured assets and HTML,
 * downloads the CSS and all font files it references, and returns them as
 * synthesized CapturedAsset entries ready to be added to the asset table.
 *
 * @param existingAssets  The full capture.assets list (to scan for googleapis URLs)
 * @param renderedHtml    Concatenated renderedHtml from all captured pages
 * @param existingUrls    Set of URLs already in the asset table (to skip re-fetching)
 */
export async function bundleGoogleFonts(
  existingAssets: CapturedAsset[],
  renderedHtml: string,
  existingUrls: Set<string>
): Promise<GoogleFontsBundle> {
  const warnings: string[] = [];
  const assets: CapturedAsset[] = [];
  const cssUrlToLocalPath = new Map<string, string>();

  // Collect all Google Fonts CSS URLs from:
  // 1. Already-captured assets (Playwright intercepted the request)
  // 2. <link href="..."> tags in the rendered HTML (may have been missed)
  const googleFontsCssUrls = new Set<string>();

  for (const asset of existingAssets) {
    if (isGoogleFontsCssUrl(asset.url)) {
      googleFontsCssUrls.add(asset.url);
    }
  }

  // Scan HTML for Google Fonts <link> tags
  const linkPattern = /href\s*=\s*["'](https:\/\/fonts\.googleapis\.com\/css[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = linkPattern.exec(renderedHtml)) !== null) {
    if (m[1]) googleFontsCssUrls.add(m[1]);
  }

  if (googleFontsCssUrls.size === 0) {
    return { assets, cssUrlToLocalPath, warnings };
  }

  for (const cssUrl of googleFontsCssUrls) {
    // Fetch CSS with desktop UA to get woff2 format
    let css: string;
    try {
      const response = await fetch(cssUrl, {
        headers: { "User-Agent": DESKTOP_UA },
      });
      if (!response.ok) {
        warnings.push(`Google Fonts CSS not fetchable (HTTP ${response.status}): ${cssUrl}`);
        continue;
      }
      css = await response.text();
    } catch (err) {
      warnings.push(`Google Fonts CSS fetch failed: ${cssUrl} — ${String(err)}`);
      continue;
    }

    // Extract font file URLs from the CSS
    const fontFileUrls = extractFontFileUrls(css);

    // Download each font file
    const fontFileLocalPaths = new Map<string, string>();
    for (const fontUrl of fontFileUrls) {
      if (existingUrls.has(fontUrl)) {
        // Already captured by Playwright — just record the local path mapping
        fontFileLocalPaths.set(fontUrl, localFontPath(fontUrl));
        continue;
      }
      try {
        const response = await fetch(fontUrl);
        if (!response.ok) {
          warnings.push(`Google Font file not fetchable (HTTP ${response.status}): ${fontUrl}`);
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const localPath = localFontPath(fontUrl);
        fontFileLocalPaths.set(fontUrl, localPath);
        assets.push({
          url: fontUrl,
          type: "font",
          buffer,
          status: 200,
          discoveredViaInteraction: false,
        });
      } catch (err) {
        warnings.push(`Google Font file fetch failed: ${fontUrl} — ${String(err)}`);
      }
    }

    // Rewrite the CSS so its url() values point at local paths.
    // We compute relative paths from the CSS file location to each font.
    const cssLocalPath = localCssPath(cssUrl);
    const cssDir = cssLocalPath.split("/").slice(0, -1).join("/");

    let rewrittenCss = css;
    for (const [fontUrl, fontLocalPath] of fontFileLocalPaths) {
      // Compute relative path from the CSS file to the font file
      const fontDir = fontLocalPath.split("/").slice(0, -1).join("/");
      const relative = computeRelativePath(cssDir, fontLocalPath);
      // Replace both quoted and unquoted url() forms
      rewrittenCss = rewrittenCss.replaceAll(
        `url(${fontUrl})`,
        `url(${relative})`
      );
      rewrittenCss = rewrittenCss.replaceAll(
        `url("${fontUrl}")`,
        `url("${relative}")`
      );
      rewrittenCss = rewrittenCss.replaceAll(
        `url('${fontUrl}')`,
        `url('${relative}')`
      );
    }

    // Register the rewritten CSS as a synthesized asset
    assets.push({
      url: cssUrl,
      type: "stylesheet",
      buffer: Buffer.from(rewrittenCss, "utf-8"),
      status: 200,
      discoveredViaInteraction: false,
    });

    cssUrlToLocalPath.set(cssUrl, cssLocalPath);
  }

  return { assets, cssUrlToLocalPath, warnings };
}

/**
 * Computes a relative POSIX path from a directory to a target file.
 */
function computeRelativePath(fromDir: string, toFile: string): string {
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = toFile.split("/").filter(Boolean);

  let commonLen = 0;
  while (
    commonLen < fromParts.length &&
    commonLen < toParts.length &&
    fromParts[commonLen] === toParts[commonLen]
  ) {
    commonLen++;
  }

  const ups = fromParts.length - commonLen;
  const rel = [
    ...Array(ups).fill(".."),
    ...toParts.slice(commonLen),
  ].join("/");

  return rel || "./";
}
