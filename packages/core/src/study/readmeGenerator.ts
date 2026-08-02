import type {
  CaptureResult,
  SourceMapFinding,
  FrameworkDetectionResult,
} from "../types/index.js";
import type { InferredComponent } from "./componentInference.js";

export interface ReadmeContext {
  capture: CaptureResult;
  components: InferredComponent[];
  gsapDetected: boolean;
  threeSceneIntrospectable: boolean;
  hasCanvasContent: boolean;
  externalCredentialWarnings: string[];
}

/**
 * Builds the accuracy-expectations table required by PRD section 8.1,
 * but scoped to what was *actually detected* for this specific capture
 * rather than printing the same static ranges regardless of site. A
 * confirmed source map, for instance, should visibly raise the stated
 * code-readability range for this output — that's the whole point of
 * detecting it in the first place (see analyze/sourceMaps.ts).
 */
function buildAccuracyTable(ctx: ReadmeContext): string {
  const { capture, gsapDetected, threeSceneIntrospectable, hasCanvasContent } = ctx;
  const confirmedMaps = capture.sourceMaps.filter((m) => m.confirmed);
  const hasConfirmedSourceMaps = confirmedMaps.length > 0;

  const rows: Array<[string, string, string]> = [
    [
      "Visual layout",
      "85–95%",
      "Computed styles and multi-viewport capture were used; minor differences possible at uncaptured breakpoints.",
    ],
    [
      "HTML structure",
      "95%+",
      "The rendered DOM is what the browser produced; preserved as-is aside from Study mode's beautification.",
    ],
    [
      "CSS readability",
      hasConfirmedSourceMaps ? "85–95%" : "70–80%",
      hasConfirmedSourceMaps
        ? "Confirmed source map(s) were found for at least one stylesheet — see Source Maps section below."
        : "Beautified from the captured stylesheet; original file boundaries and authoring structure are not recoverable.",
    ],
    [
      "JavaScript readability",
      hasConfirmedSourceMaps ? "85–95% (mapped bundles)" : "40–60%",
      hasConfirmedSourceMaps
        ? "Confirmed source map(s) were found — affected bundles can be reconstructed close to original source."
        : "Beautified (re-indented) only. Minified identifier names are not recoverable from the bundle alone.",
    ],
    [
      "Interactive elements (menus, modals, accordions)",
      "60–80%",
      "Client-side JS bundles are preserved functionally in Run mode; behavior depends on what was triggered during capture.",
    ],
    [
      "Component structure (this Study-mode output)",
      "Heuristic, not ground truth",
      `${ctx.components.length} component boundary/boundaries inferred from semantic tags, class names, and structural repetition. Names are best-effort guesses, not recovered original names.`,
    ],
  ];

  if (gsapDetected) {
    rows.push([
      "Scroll/animation timing (GSAP detected)",
      "40–65%",
      "Precise scroll-bound animation sequences often degrade outside their original tuning. See scroll-frame reference images if generated.",
    ]);
  }

  if (hasCanvasContent) {
    rows.push([
      "Canvas/WebGL visuals",
      threeSceneIntrospectable ? "50–70%" : "30–60%",
      threeSceneIntrospectable
        ? "Some scene-graph structure was introspectable; this is unusual for production builds and may indicate exposed debug state."
        : "No live scene graph was accessible (expected for production builds). Static snapshot(s) only — see captured canvas images.",
    ]);
  }

  const header = "| Aspect | Estimated Accuracy | Notes |\n|---|---|---|";
  const body = rows.map(([aspect, acc, notes]) => `| ${aspect} | ${acc} | ${notes} |`).join("\n");
  return `${header}\n${body}`;
}

function describeFramework(framework: FrameworkDetectionResult): string {
  if (framework.frameworks[0] === "unknown" || framework.frameworks.length === 0) {
    return "Not confidently detected (may be plain HTML/CSS/JS, or detection signals were inconclusive).";
  }
  return framework.frameworks.join(", ");
}

function describeSourceMaps(sourceMaps: SourceMapFinding[]): string {
  if (sourceMaps.length === 0) {
    return "No source map references were found in any captured bundle. This is the typical case for production deployments.";
  }
  const confirmed = sourceMaps.filter((m) => m.confirmed);
  const lines = [
    `${sourceMaps.length} bundle(s) referenced a source map; ${confirmed.length} were confirmed accessible.`,
  ];
  for (const finding of sourceMaps) {
    lines.push(`- ${finding.bundleUrl} → ${finding.confirmed ? "confirmed" : "referenced but not accessible"}`);
  }
  return lines.join("\n");
}

/**
 * Generates the full README.md content for a Study-mode output
 * directory. This is the primary place a user encounters this project's
 * own honesty commitments (PRD section 9), so the ethical-use notice and
 * the scoped accuracy table are both non-optional sections, not
 * appendable extras.
 */
export function generateReadme(ctx: ReadmeContext): string {
  const { capture } = ctx;
  const hostname = new URL(capture.targetUrl).hostname;

  return `# Study Clone: ${hostname}

> **This is a generated study clone, not the original source code.**
> It was produced by an automated capture tool for personal learning,
> study, and redesign practice. Do not redistribute, rehost, or use this
> output commercially. Respect the original site's Terms of Service.

## Source

- **URL:** ${capture.targetUrl}
- **Captured at:** ${capture.capturedAt}
- **Pages captured:** ${new Set(capture.pages.map((p) => p.url)).size}
- **Detected framework(s):** ${describeFramework(capture.framework)}
- **Detected CSS approach:** ${capture.framework.cssApproach}

## Accuracy Expectations

These estimates are scoped to what was actually detected during capture,
not generic figures. They describe this specific output, not a guarantee.

${buildAccuracyTable(ctx)}

## Source Maps

${describeSourceMaps(capture.sourceMaps)}

## Project Structure

\`\`\`
src/
├── components/   # ${ctx.components.length} inferred component(s) — see "Component structure" note above
├── pages/         # One file per crawled page
├── styles/        # Beautified CSS
└── utils/         # Extracted JS, beautified where possible
assets/
├── images/
├── fonts/
└── media/
\`\`\`

## External Dependencies Still Required

${
  capture.externalDependencies.length > 0
    ? `This site's code still references the following external domain(s) at runtime:\n${capture.externalDependencies.map((d) => `- ${d}`).join("\n")}\n\nFeatures relying on these will only work if those services remain reachable.`
    : "No external runtime dependencies were detected outside the site's own origin."
}

${
  ctx.externalCredentialWarnings.length > 0
    ? `## Domain-Locked Credentials Detected\n\n${ctx.externalCredentialWarnings.map((w) => `- ${w}`).join("\n")}\n`
    : ""
}
## Getting Started

This directory pairs with the Run-mode output produced for the same
capture (see that directory's \`SERVING.md\`). This Study-mode output is
meant for reading and learning from, not necessarily for running
directly — some inferred component files are illustrative splits of the
original page, not independently functioning modules.

## A Note on AI-Assisted Content

If this output includes an AI-assisted refactoring pass, every file or
section produced that way is marked with a header comment. Unmarked
files are mechanically extracted/beautified only — no AI inference was
applied to their content.
`;
}
