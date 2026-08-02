import type { CaptureResult } from "../types/index.js";

export interface GeneratePackageJsonOptions {
  capture: CaptureResult;
  /** The published version of this tool, for provenance traceability. */
  toolVersion: string;
}

function slugify(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generates package.json content for a Study-mode output directory.
 * Deliberately minimal on actual `dependencies` — this output is meant
 * for reading, not for `npm install && npm run build` reproducing the
 * original site (that's Run mode's job, and Run mode doesn't use a
 * package.json at all since it ships already-built assets). The scripts
 * here are conveniences for local viewing/formatting only.
 */
export function generatePackageJson(options: GeneratePackageJsonOptions): string {
  const { capture, toolVersion } = options;
  const hostname = new URL(capture.targetUrl).hostname;

  const pkg = {
    name: `${slugify(hostname)}-study-clone`,
    version: "0.1.0",
    private: true,
    description: `Frontend study clone of ${capture.targetUrl}, generated for personal learning purposes.`,
    scripts: {
      format: "prettier --write \"src/**/*.{html,css,js}\"",
    },
    devDependencies: {
      prettier: "^3.2.5",
    },
    studyClone: {
      tool: "frontend-study-cloner",
      toolVersion,
      mode: "study",
      sourceUrl: capture.targetUrl,
      capturedAt: capture.capturedAt,
      detectedFramework: capture.framework.frameworks,
      detectedCssApproach: capture.framework.cssApproach,
      purpose: "Personal learning, study, and redesign practice only. Not for redistribution or commercial use.",
    },
  };

  return JSON.stringify(pkg, null, 2);
}
