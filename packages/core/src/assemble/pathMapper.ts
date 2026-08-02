import { createHash } from "node:crypto";
import path from "node:path";
import type { AssetType, CapturedAsset } from "../types/index.js";

const ASSET_TYPE_FOLDER: Record<AssetType, string> = {
  document: "", // documents (HTML pages) live at the output root, not under assets/
  script: "assets/js",
  stylesheet: "assets/css",
  image: "assets/images",
  font: "assets/fonts",
  media: "assets/media",
  other: "assets/misc",
};

/** Characters forbidden or discouraged across Windows/Unix/ISO9660, per the HTTrack chapter's own list. */
const UNSAFE_FILENAME_CHARS = /[<>:"|?*\\/\x00-\x1f]/g;

export interface PathMapping {
  /** The original, fully-qualified URL as captured. */
  originalUrl: string;
  /** Path relative to the output directory root, using forward slashes. */
  localPath: string;
}

export interface BuildPathMappingsOptions {
  /**
   * When true (Run mode default), assets are placed at the same relative
   * path they had on the origin server — e.g. /_next/static/css/hash.css
   * stays at _next/static/css/hash.css in the output directory. This is
   * critical for Next.js and other frameworks whose JavaScript bundles
   * contain hardcoded `/_next/static/` string literals that our rewriter
   * cannot safely patch. With a preserved structure, root-relative URLs in
   * HTML resolve naturally when the output is served from its root directory,
   * and no HTML rewriting is needed for same-origin path-based references.
   *
   * When false (Study mode), assets are reorganized into human-readable
   * type-based folders (assets/css/, assets/js/, assets/images/, etc.) for
   * codebase navigability. Study mode does not wire up a working local server,
   * so functional fidelity concerns do not apply.
   *
   * Default: false (preserves existing Study-mode behaviour for callers that
   * do not pass this option).
   */
  preserveStructure?: boolean;
}

/**
 * Builds a stable, collision-free mapping from captured asset URLs to
 * local file paths. This is a pure function over the full asset list
 * (not a per-asset function) because collision resolution requires
 * knowing about every other asset's chosen name up front — exactly the
 * problem described in the source chapter, where four different URLs
 * could all naively resolve to "index_1.html".
 *
 * Pass `{ preserveStructure: true }` for Run mode to keep Next.js and
 * other framework assets at their original paths; omit it (or pass false)
 * for Study mode's reorganized folder layout.
 */
export function buildPathMappings(
  assets: CapturedAsset[],
  options: BuildPathMappingsOptions = {}
): Map<string, PathMapping> {
  const mappings = new Map<string, PathMapping>();
  const usedPaths = new Set<string>();

  for (const asset of assets) {
    const localPath = resolveUniqueLocalPath(asset, usedPaths, options.preserveStructure ?? false);
    usedPaths.add(localPath);
    mappings.set(asset.url, { originalUrl: asset.url, localPath });
  }

  return mappings;
}

function resolveUniqueLocalPath(
  asset: CapturedAsset,
  usedPaths: Set<string>,
  preserveStructure: boolean
): string {
  const base = preserveStructure
    ? buildPreservedPath(asset)
    : buildCandidatePath(asset);
  if (!usedPaths.has(base)) return base;

  // Collision: append a short content hash of the URL itself (stable,
  // deterministic, and avoids the "-2", "-3" ambiguity the HTTrack
  // chapter flags as still not fully resolving which version is which).
  const { dir, name, ext } = splitPath(base);
  const hash = createHash("md5").update(asset.url).digest("hex").slice(0, 6);
  const disambiguated = path.posix.join(dir, `${name}-${hash}${ext}`);
  return disambiguated;
}

/**
 * Builds a local path that mirrors the URL's path structure exactly,
 * without type-based folder prefixes. Used by Run mode so that
 * framework-internal references like `/_next/static/css/hash.css`
 * remain valid without any HTML/JS rewriting.
 *
 * Documents (HTML pages) are written as `<slug>/index.html` rather than
 * `<slug>.html` so that when served at `/<slug>/` (with the trailing slash
 * that static servers add for clean-URL rewrites), relative asset paths
 * like `../_next/static/chunks/webpack-xxx.js` correctly resolve to
 * `/_next/static/chunks/webpack-xxx.js`. If we wrote `salaries.html` at
 * the root instead, the browser at `/salaries/` would resolve
 * `_next/static/...` as `/salaries/_next/...` which doesn't exist —
 * causing every JS chunk to return the SPA fallback HTML and fail with
 * "Unexpected token '<'".
 */
function buildPreservedPath(asset: CapturedAsset): string {
  const url = new URL(asset.url);

  let pathname = decodeURIComponent(url.pathname);

  // Root document
  if (pathname === "" || pathname === "/") {
    return "index.html";
  }

  if (pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1); // strip trailing slash, handle below
  }

  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));

  const lastSegment = segments[segments.length - 1] ?? "index";
  const ext = path.extname(lastSegment);

  if (asset.type === "document" && !hasMatchingExtension(ext, "document")) {
    // Sub-page document: write as <slug>/index.html so relative asset
    // paths work correctly when served at /<slug>/ with a trailing slash.
    // e.g. /salaries → salaries/index.html
    //      /work/project-1 → work/project-1/index.html
    return path.posix.join(...segments, "index.html");
  }

  // Non-document assets (CSS, JS, fonts, images): preserve exact path.
  const dir = segments.slice(0, -1).join("/");
  const filename = lastSegment;
  return dir ? path.posix.join(dir, filename) : filename;
}

function buildCandidatePath(asset: CapturedAsset): string {
  const url = new URL(asset.url);
  const folder = ASSET_TYPE_FOLDER[asset.type];

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "" || pathname === "/") {
    pathname = "/index";
  }
  if (pathname.endsWith("/")) {
    pathname += "index";
  }

  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));

  let filename = segments.pop() ?? "index";
  const ext = path.extname(filename);

  // If there's no extension at all (common for document routes like
  // "/about"), or the extension doesn't match the asset's actual type
  // (e.g. a route serving HTML through a path with no .html, or a CGI-
  // style endpoint that happens to return CSS), normalize it based on
  // what we actually captured rather than trusting the URL's own
  // extension, per the HTTrack chapter's point that "the URL naming
  // scheme is not important — it is the media type transmitted by the
  // server that is decisive."
  if (asset.type !== "other" && !hasMatchingExtension(ext, asset.type)) {
    const nameWithoutExt = ext ? filename.slice(0, -ext.length) : filename;
    filename = `${nameWithoutExt}${defaultExtensionFor(asset.type)}`;
  }

  const relativeDir = segments.join("/");
  const fullDir = folder ? path.posix.join(folder, relativeDir) : relativeDir;
  return path.posix.join(fullDir, filename);
}

function sanitizeSegment(segment: string): string {
  // Case folding is intentionally NOT applied here — unlike the legacy
  // Windows-case-insensitivity problem the HTTrack chapter describes,
  // modern deploy targets (Vercel, Netlify, most static hosts) run on
  // case-sensitive filesystems, so preserving original case is more
  // faithful to the source and only risks collision in the rarer case
  // of two URLs differing solely by case — which resolveUniqueLocalPath
  // already handles via hashing.
  const cleaned = segment.replace(UNSAFE_FILENAME_CHARS, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

function hasMatchingExtension(ext: string, type: AssetType): boolean {
  const known: Record<AssetType, string[]> = {
    document: [".html", ".htm"],
    script: [".js", ".mjs", ".cjs"],
    stylesheet: [".css"],
    image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico"],
    font: [".woff", ".woff2", ".ttf", ".otf", ".eot"],
    media: [".mp4", ".webm", ".mp3", ".wav", ".ogg"],
    other: [],
  };
  return known[type].includes(ext.toLowerCase());
}

function defaultExtensionFor(type: AssetType): string {
  const defaults: Record<AssetType, string> = {
    document: ".html",
    script: ".js",
    stylesheet: ".css",
    image: ".bin", // genuinely ambiguous without inspecting magic bytes; safer than guessing wrong
    font: ".woff2",
    media: ".bin",
    other: "",
  };
  return defaults[type];
}

function splitPath(fullPath: string): { dir: string; name: string; ext: string } {
  const dir = path.posix.dirname(fullPath);
  const ext = path.posix.extname(fullPath);
  const name = path.posix.basename(fullPath, ext);
  return { dir: dir === "." ? "" : dir, name, ext };
}
