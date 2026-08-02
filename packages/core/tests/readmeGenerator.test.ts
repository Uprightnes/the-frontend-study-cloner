import { describe, it, expect } from "vitest";
import { generateReadme, type ReadmeContext } from "../src/study/readmeGenerator.js";
import type { CaptureResult } from "../src/types/index.js";

function baseCapture(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return {
    targetUrl: "https://example.com/",
    capturedAt: "2026-06-18T00:00:00.000Z",
    pages: [
      {
        url: "https://example.com/",
        viewport: { name: "desktop", width: 1440, height: 900 },
        renderedHtml: "<html></html>",
        computedStyles: [],
      },
    ],
    assets: [],
    sourceMaps: [],
    framework: { frameworks: ["unknown"], cssApproach: "unknown" },
    externalDependencies: [],
    ...overrides,
  };
}

function baseContext(overrides: Partial<ReadmeContext> = {}): ReadmeContext {
  return {
    capture: baseCapture(),
    components: [],
    gsapDetected: false,
    threeSceneIntrospectable: false,
    hasCanvasContent: false,
    externalCredentialWarnings: [],
    ...overrides,
  };
}

describe("generateReadme", () => {
  it("always includes the non-optional ethical use notice", () => {
    const readme = generateReadme(baseContext());
    expect(readme).toContain("not the original source code");
    expect(readme).toContain("Do not redistribute");
  });

  it("states the lower JS/CSS readability range when no source maps are present", () => {
    const readme = generateReadme(baseContext());
    expect(readme).toContain("40–60%");
    expect(readme).not.toContain("85–95% (mapped bundles)");
  });

  it("raises the JS/CSS readability range when a confirmed source map is present", () => {
    const ctx = baseContext({
      capture: baseCapture({
        sourceMaps: [{ bundleUrl: "https://example.com/main.js", mapUrl: "https://example.com/main.js.map", confirmed: true }],
      }),
    });
    const readme = generateReadme(ctx);
    expect(readme).toContain("85–95% (mapped bundles)");
  });

  it("does not raise the range for a referenced-but-unconfirmed source map", () => {
    const ctx = baseContext({
      capture: baseCapture({
        sourceMaps: [{ bundleUrl: "https://example.com/main.js", mapUrl: "https://example.com/main.js.map", confirmed: false }],
      }),
    });
    const readme = generateReadme(ctx);
    expect(readme).toContain("40–60%");
  });

  it("only includes the GSAP accuracy row when GSAP was actually detected", () => {
    const withGsap = generateReadme(baseContext({ gsapDetected: true }));
    const withoutGsap = generateReadme(baseContext({ gsapDetected: false }));
    expect(withGsap).toContain("Scroll/animation timing (GSAP detected)");
    expect(withoutGsap).not.toContain("Scroll/animation timing");
  });

  it("only includes the canvas/WebGL row when canvas content was detected", () => {
    const withCanvas = generateReadme(baseContext({ hasCanvasContent: true }));
    const withoutCanvas = generateReadme(baseContext({ hasCanvasContent: false }));
    expect(withCanvas).toContain("Canvas/WebGL visuals");
    expect(withoutCanvas).not.toContain("Canvas/WebGL visuals");
  });

  it("gives a higher canvas accuracy estimate only when the scene graph was actually introspectable", () => {
    const introspectable = generateReadme(
      baseContext({ hasCanvasContent: true, threeSceneIntrospectable: true })
    );
    const notIntrospectable = generateReadme(
      baseContext({ hasCanvasContent: true, threeSceneIntrospectable: false })
    );
    expect(introspectable).toContain("50–70%");
    expect(notIntrospectable).toContain("30–60%");
  });

  it("reports zero external dependencies clearly when none were detected", () => {
    const readme = generateReadme(baseContext());
    expect(readme).toContain("No external runtime dependencies were detected");
  });

  it("lists external dependencies when present", () => {
    const ctx = baseContext({
      capture: baseCapture({ externalDependencies: ["maps.googleapis.com", "stripe.com"] }),
    });
    const readme = generateReadme(ctx);
    expect(readme).toContain("maps.googleapis.com");
    expect(readme).toContain("stripe.com");
  });

  it("omits the credential warnings section entirely when there are none", () => {
    const readme = generateReadme(baseContext());
    expect(readme).not.toContain("Domain-Locked Credentials Detected");
  });

  it("includes credential warnings when present", () => {
    const readme = generateReadme(
      baseContext({ externalCredentialWarnings: ["[Google Maps] API key detected"] })
    );
    expect(readme).toContain("Domain-Locked Credentials Detected");
    expect(readme).toContain("Google Maps");
  });

  it("always includes the AI-content labeling commitment, even before any AI pass exists", () => {
    const readme = generateReadme(baseContext());
    expect(readme).toContain("marked with a header comment");
  });
});
