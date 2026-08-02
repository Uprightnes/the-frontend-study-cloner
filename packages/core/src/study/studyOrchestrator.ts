import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptureResult, CapturedAsset } from "../types/index.js";
import { beautifyHtml, beautifyCss, beautifyJs } from "./beautify.js";
import { inferComponents } from "./componentInference.js";
import { generateReadme } from "./readmeGenerator.js";
import { generatePackageJson } from "./packageJsonGenerator.js";
import { detectDomainLockedCredentials } from "../assemble/credentialWarnings.js";

const TOOL_VERSION = "0.1.0";

export interface AssembleStudyModeResult {
  outputDir: string;
  filesWritten: string[];
  warnings: string[];
  componentCount: number;
}

/**
 * Builds a safe, unique base filename from a page URL, for use under
 * src/pages/. The homepage gets "home"; other paths get a slugified
 * version of their pathname.
 */
function pageFileBaseName(pageUrl: string): string {
  const { pathname } = new URL(pageUrl);
  if (pathname === "/" || pathname === "") return "home";
  const slug = pathname.replace(/^\/|\/$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
  return slug || "home";
}

function componentFileName(name: string, usedNames: Set<string>): string {
  let candidate = name;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${name}-${suffix}`;
    suffix++;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Writes one canonical page (the desktop-viewport capture, matching the
 * same preference Run mode uses) into src/pages/, beautified. The full
 * page is always written as a complete, self-contained file — component
 * extraction (below) produces supplementary illustrative copies of
 * sub-sections, not a refactor that removes content from the page file.
 * This guarantees src/pages/ output is never broken or partial, even
 * though it means some markup is intentionally duplicated between a page
 * file and its extracted components. That tradeoff is stated explicitly
 * in the generated README.
 */
async function writePages(
  capture: CaptureResult,
  outputDir: string,
  warnings: string[]
): Promise<string[]> {
  const filesWritten: string[] = [];
  const canonicalPages = new Map<string, CaptureResult["pages"][number]>();

  for (const page of capture.pages) {
    const existing = canonicalPages.get(page.url);
    if (!existing || page.viewport.name === "desktop") {
      canonicalPages.set(page.url, page);
    }
  }

  for (const [url, page] of canonicalPages) {
    const { output, succeeded } = await beautifyHtml(page.renderedHtml);
    if (!succeeded) {
      warnings.push(`Beautification failed for page ${url}; wrote unformatted HTML instead.`);
    }

    const fileName = `${pageFileBaseName(url)}.html`;
    const fullPath = path.join(outputDir, "src", "pages", fileName);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, output, "utf-8");
    filesWritten.push(path.join("src", "pages", fileName));
  }

  return filesWritten;
}

/**
 * Extracts and writes inferred components for every distinct captured
 * page. Components are named per-page first (e.g. "Header"), then
 * disambiguated globally across the whole site so a "Header" found on
 * the homepage and a structurally-similar one on /about don't collide
 * into the same output file.
 */
async function writeComponents(
  capture: CaptureResult,
  outputDir: string,
  warnings: string[]
): Promise<{ filesWritten: string[]; componentCount: number }> {
  const filesWritten: string[] = [];
  const usedNames = new Set<string>();
  let componentCount = 0;

  const canonicalPages = new Map<string, CaptureResult["pages"][number]>();
  for (const page of capture.pages) {
    const existing = canonicalPages.get(page.url);
    if (!existing || page.viewport.name === "desktop") {
      canonicalPages.set(page.url, page);
    }
  }

  for (const [, page] of canonicalPages) {
    const components = inferComponents(page.renderedHtml);
    for (const component of components) {
      const { output, succeeded } = await beautifyHtml(component.html);
      if (!succeeded) {
        warnings.push(`Beautification failed for inferred component "${component.name}".`);
      }

      const fileName = componentFileName(component.name, usedNames);
      const fullPath = path.join(outputDir, "src", "components", `${fileName}.html`);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, output, "utf-8");
      filesWritten.push(path.join("src", "components", `${fileName}.html`));
      componentCount++;
    }
  }

  return { filesWritten, componentCount };
}

/**
 * Beautifies and writes every captured CSS and JS asset under
 * src/styles/ and src/utils/ respectively. Unlike Run mode, Study mode
 * does NOT rewrite url()/import paths inside these files — Study mode's
 * stated purpose is reading, not running (see README's "Getting
 * Started" section), so these are presented for inspection rather than
 * wired into a working local server. A reader who wants a working copy
 * is directed to the paired Run-mode output.
 */
async function writeStylesAndScripts(
  capture: CaptureResult,
  outputDir: string,
  warnings: string[]
): Promise<string[]> {
  const filesWritten: string[] = [];

  for (const asset of capture.assets) {
    if (!asset.buffer) continue;
    if (asset.type !== "stylesheet" && asset.type !== "script") continue;

    const folder = asset.type === "stylesheet" ? "styles" : "utils";
    const ext = asset.type === "stylesheet" ? ".css" : ".js";
    const baseName = sanitizeAssetBaseName(asset.url);
    const fileName = `${baseName}${ext}`;

    const text = asset.buffer.toString("utf-8");
    const { output, succeeded } =
      asset.type === "stylesheet" ? await beautifyCss(text) : await beautifyJs(text);

    if (!succeeded) {
      warnings.push(
        `Beautification failed for ${asset.url}; wrote original minified content instead. ` +
          `This is common for heavily-bundled or obfuscated JS and does not indicate a tool error.`
      );
    }

    const fullPath = path.join(outputDir, "src", folder, fileName);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, output, "utf-8");
    filesWritten.push(path.join("src", folder, fileName));
  }

  return filesWritten;
}

function sanitizeAssetBaseName(url: string): string {
  const { pathname } = new URL(url);
  const base = path.posix.basename(pathname).replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "asset";
}

/** True if any captured page's HTML contains a <canvas> element, used to decide whether the README's canvas/WebGL row applies. */
function detectCanvasContent(capture: CaptureResult): boolean {
  return capture.pages.some((p) => /<canvas[\s>]/i.test(p.renderedHtml));
}

export interface AssembleStudyModeOptions {
  outputDir: string;
  gsapDetected: boolean;
  threeSceneIntrospectable: boolean;
}

/**
 * Top-level Study-mode entrypoint. Produces the readable, GitHub-repo-
 * style output: beautified pages/styles/scripts, heuristically inferred
 * components, and a README/package.json scoped to what was actually
 * detected for this capture. This is the deterministic, no-AI tier —
 * per the project's phased plan, the optional AI-assisted refactor pass
 * is a separate, later module that consumes this same output rather
 * than being required for Study mode to be useful on its own.
 */
export async function assembleStudyMode(
  capture: CaptureResult,
  options: AssembleStudyModeOptions
): Promise<AssembleStudyModeResult> {
  const warnings: string[] = [];
  const filesWritten: string[] = [];

  const pageFiles = await writePages(capture, options.outputDir, warnings);
  filesWritten.push(...pageFiles);

  const { filesWritten: componentFiles, componentCount } = await writeComponents(
    capture,
    options.outputDir,
    warnings
  );
  filesWritten.push(...componentFiles);

  const styleAndScriptFiles = await writeStylesAndScripts(capture, options.outputDir, warnings);
  filesWritten.push(...styleAndScriptFiles);

  const credentialWarnings = detectDomainLockedCredentials(capture.assets).map(
    (c) => `[${c.service}] ${c.description} (found in ${c.bundleUrl})`
  );

  // Re-run component inference once more here just to build the README's
  // component count/list — writeComponents() already ran it per-page for
  // file writing, but doesn't return the InferredComponent objects
  // themselves (only file paths), and re-deriving from the same pure
  // function is simpler and cheaper than threading that data through
  // two layers of return values for a count the README needs once.
  const allComponents = capture.pages.flatMap((p) => inferComponents(p.renderedHtml));

  const readme = generateReadme({
    capture,
    components: allComponents,
    gsapDetected: options.gsapDetected,
    threeSceneIntrospectable: options.threeSceneIntrospectable,
    hasCanvasContent: detectCanvasContent(capture),
    externalCredentialWarnings: credentialWarnings,
  });
  await writeFile(path.join(options.outputDir, "README.md"), readme, "utf-8");
  filesWritten.push("README.md");

  const packageJson = generatePackageJson({ capture, toolVersion: TOOL_VERSION });
  await writeFile(path.join(options.outputDir, "package.json"), packageJson, "utf-8");
  filesWritten.push("package.json");

  const marker = {
    tool: "frontend-study-cloner",
    mode: "study",
    sourceUrl: capture.targetUrl,
    capturedAt: capture.capturedAt,
    notice:
      "This directory was generated by an automated capture tool for personal " +
      "learning and study purposes. Component boundaries and names are " +
      "best-effort heuristic inferences, not recovered original source. " +
      "Must not be redistributed, rehosted, or used commercially.",
  };
  await writeFile(
    path.join(options.outputDir, ".study-clone"),
    JSON.stringify(marker, null, 2),
    "utf-8"
  );
  filesWritten.push(".study-clone");

  if (componentCount === 0) {
    warnings.push(
      "No components were inferred from any captured page. This can happen on " +
        "sites with very flat or unconventional markup; the page files under " +
        "src/pages/ still contain the complete, beautified content."
    );
  }

  return { outputDir: options.outputDir, filesWritten, warnings, componentCount };
}
