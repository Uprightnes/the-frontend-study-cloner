import path from "node:path";
import type { PathMapping } from "./pathMapper.js";

/**
 * Computes a relative path from one local output path to another, for
 * use inside rewritten href/src attributes. Always POSIX-style forward
 * slashes regardless of host OS, since this path is going inside a file
 * that will be served over HTTP.
 */
function relativeFrom(fromFile: string, toFile: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Rewrites every absolute and root-relative URL reference in an HTML
 * document to a path relative to that document's own location in the
 * output tree. Operates via simple, well-scoped regex passes over known
 * attribute patterns rather than a full HTML parse, which keeps this
 * fast and dependency-light; a fuller implementation could swap in an
 * HTML AST parser (e.g. for Study mode) without changing this function's
 * contract.
 */
export function rewriteHtmlReferences(
  html: string,
  documentLocalPath: string,
  mappings: Map<string, PathMapping>,
  originUrl: string
): string {
  const attrPattern = /(href|src|srcset|poster)\s*=\s*(["'])([^"']*)\2/gi;

  return html.replace(attrPattern, (full, attr, quote, value) => {
    // srcset can contain multiple comma-separated URL+descriptor pairs;
    // handle it distinctly rather than treating the whole thing as one URL.
    if (attr.toLowerCase() === "srcset") {
      const rewritten = rewriteSrcset(value, documentLocalPath, mappings, originUrl);
      return `${attr}=${quote}${rewritten}${quote}`;
    }

    const resolved = resolveToLocalOrLeaveAlone(value, documentLocalPath, mappings, originUrl);
    return `${attr}=${quote}${resolved}${quote}`;
  });
}

function rewriteSrcset(
  srcsetValue: string,
  documentLocalPath: string,
  mappings: Map<string, PathMapping>,
  originUrl: string
): string {
  return srcsetValue
    .split(",")
    .map((entry) => {
      const trimmed = entry.trim();
      const [url, ...descriptor] = trimmed.split(/\s+/);
      if (!url) return entry;
      const resolved = resolveToLocalOrLeaveAlone(url, documentLocalPath, mappings, originUrl);
      return [resolved, ...descriptor].join(" ");
    })
    .join(", ");
}

function resolveToLocalOrLeaveAlone(
  rawValue: string,
  documentLocalPath: string,
  mappings: Map<string, PathMapping>,
  originUrl: string
): string {
  if (
    !rawValue ||
    rawValue.startsWith("data:") ||
    rawValue.startsWith("#") ||
    rawValue.startsWith("mailto:") ||
    rawValue.startsWith("tel:") ||
    rawValue.startsWith("javascript:")
  ) {
    return rawValue;
  }

  let absolute: string;
  try {
    absolute = new URL(rawValue, originUrl).href;
  } catch {
    return rawValue;
  }

  const mapping = mappings.get(absolute);
  if (mapping) {
    let localPath = mapping.localPath;
    // Sub-page documents are stored as "salaries/index.html" on disk,
    // but links should point to "/salaries/" (clean URL) not "/salaries/index.html".
    // The root index.html is the exception — it stays as "/index.html" or "/".
    if (localPath !== "index.html" && localPath.endsWith("/index.html")) {
      return "/" + localPath.slice(0, -"index.html".length);
    }
    return "/" + localPath;
  }

  return absolute;
}

/**
 * Rewrites url(...) references inside CSS to local relative paths.
 * Same conservative approach as HTML: regex over a well-known, narrow
 * syntax rather than a full CSS parse.
 */
export function rewriteCssReferences(
  css: string,
  cssLocalPath: string,
  mappings: Map<string, PathMapping>,
  originUrl: string
): string {
  const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

  return css.replace(urlPattern, (full, quote, value) => {
    const resolved = resolveToLocalOrLeaveAlone(value, cssLocalPath, mappings, originUrl);
    return `url(${quote}${resolved}${quote})`;
  });
}

export interface JsRewriteResult {
  rewritten: string;
  /** Number of string-literal URLs that were successfully rewritten. */
  replacementCount: number;
}

/**
 * Rewrites JS bundle contents, but ONLY exact string-literal matches for
 * URLs we actually captured — and only the absolute, fully-qualified
 * form (e.g. "https://example.com/logo.png"), never anything involving
 * string concatenation or template interpolation.
 *
 * This is intentionally the most conservative function in the whole
 * assemble stage. Per the project's own risk analysis: rewriting strings
 * inside a minified bundle without understanding the surrounding code is
 * the same ~80%-heuristic territory the original HTML parser chapter
 * flagged for JS link detection, except here a wrong rewrite doesn't just
 * miss a link — it can silently corrupt working code. We accept some
 * missed rewrites (asset still points at the live origin) in exchange for
 * never breaking a bundle's logic by rewriting inside a larger expression.
 */
export function rewriteJsStringLiterals(
  js: string,
  mappings: Map<string, PathMapping>,
  jsLocalPath: string
): JsRewriteResult {
  let replacementCount = 0;

  // Build a single alternation pattern of only the absolute URLs we
  // actually have a mapping for, sorted longest-first so a URL that is a
  // prefix of another (rare, but possible with query strings) doesn't
  // shadow the more specific match.
  //
  // CRITICAL: Skip document URLs entirely. The webpack runtime bundle
  // contains the site's publicPath (e.g. "https://example.com/") which it
  // uses to construct chunk URLs at runtime:
  //   __webpack_require__.p = "https://example.com/"
  //   chunkUrl = __webpack_require__.p + "_next/static/chunks/" + chunkId
  //
  // If we rewrite "https://example.com/" to a relative path like
  // "../../../index.html", webpack constructs nonsense chunk URLs and every
  // dynamically-loaded chunk fails with "Unexpected token '<'" because the
  // browser gets the SPA fallback HTML instead of the JS file.
  //
  // Document URLs (pages) are routing constants and publicPath values in JS
  // bundles. They must never be relativized — only binary/style/script
  // assets that have a stable path relationship to the bundle can be safely
  // rewritten.
  const knownUrls = Array.from(mappings.entries())
    .filter(([url, mapping]) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
      // Skip document mappings — these are page HTML files, not assets.
      // Rewriting them corrupts webpack publicPath and router constants.
      if (mapping.localPath.endsWith("index.html") || mapping.localPath.endsWith(".html")) {
        return false;
      }
      return true;
    })
    .map(([url]) => url)
    .sort((a, b) => b.length - a.length);

  if (knownUrls.length === 0) {
    return { rewritten: js, replacementCount: 0 };
  }

  // Match the URL only when it appears as a complete quoted string literal.
  const escaped = knownUrls.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(["'])(${escaped.join("|")})\\1`, "g");

  const rewritten = js.replace(pattern, (full, quote, matchedUrl) => {
    const mapping = mappings.get(matchedUrl);
    if (!mapping) return full;
    replacementCount++;
    const relative = relativeFrom(jsLocalPath, mapping.localPath);
    return `${quote}${relative}${quote}`;
  });

  return { rewritten, replacementCount };
}
