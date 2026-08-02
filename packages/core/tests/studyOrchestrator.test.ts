import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleStudyMode } from "../src/study/studyOrchestrator.js";
import type { CaptureResult } from "../src/types/index.js";

const VIEWPORT = { name: "desktop", width: 1440, height: 900 };

function makeCapture(): CaptureResult {
  const homeHtml = `
    <html><body>
      <header class="site-header"><nav><a href="/about">About</a></nav></header>
      <main>
        <div class="hero-banner"><h1>Welcome</h1></div>
        <div class="card-grid">
          <article>One</article>
          <article>Two</article>
          <article>Three</article>
        </div>
      </main>
      <footer>Copyright 2026</footer>
    </body></html>
  `;
  const aboutHtml = `<html><body><h1>About us</h1></body></html>`;

  return {
    targetUrl: "https://example.com/",
    capturedAt: "2026-06-18T00:00:00.000Z",
    pages: [
      { url: "https://example.com/", viewport: VIEWPORT, renderedHtml: homeHtml, computedStyles: [] },
      { url: "https://example.com/about", viewport: VIEWPORT, renderedHtml: aboutHtml, computedStyles: [] },
    ],
    assets: [
      {
        url: "https://example.com/main.css",
        type: "stylesheet",
        status: 200,
        discoveredViaInteraction: false,
        buffer: Buffer.from(".a{color:red;background:blue}"),
      },
      {
        url: "https://example.com/main.js",
        type: "script",
        status: 200,
        discoveredViaInteraction: false,
        buffer: Buffer.from("function a(b){return b+1}"),
      },
    ],
    sourceMaps: [],
    framework: { frameworks: ["react"], cssApproach: "plain-css" },
    externalDependencies: [],
  };
}

describe("assembleStudyMode (integration)", () => {
  let outputDir: string;

  afterEach(async () => {
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
  });

  it("produces the full expected folder structure with real content", async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), "fsc-study-test-"));

    const result = await assembleStudyMode(makeCapture(), {
      outputDir,
      gsapDetected: false,
      threeSceneIntrospectable: false,
    });

    // Pages: both distinct URLs should produce a file.
    const homeHtml = await readFile(path.join(outputDir, "src/pages/home.html"), "utf-8");
    const aboutHtml = await readFile(path.join(outputDir, "src/pages/about.html"), "utf-8");
    expect(homeHtml).toContain("Welcome");
    expect(aboutHtml).toContain("About us");

    // Components: header, hero, and the 3-article card grid should all
    // have been inferred from the homepage and written as separate files.
    await expect(access(path.join(outputDir, "src/components/Header.html"))).resolves.toBeUndefined();
    await expect(access(path.join(outputDir, "src/components/Hero.html"))).resolves.toBeUndefined();
    expect(result.componentCount).toBeGreaterThan(0);

    // Styles and scripts: beautified versions should exist and actually
    // be reformatted (not byte-identical to the dense minified input).
    const css = await readFile(path.join(outputDir, "src/styles/main.css"), "utf-8");
    const js = await readFile(path.join(outputDir, "src/utils/main.js"), "utf-8");
    expect(css).toContain("color: red");
    expect(css.split("\n").length).toBeGreaterThan(1); // beautified, not one dense line
    expect(js).toContain("function a(b)");

    // README and package.json must exist and reflect actual capture data.
    const readme = await readFile(path.join(outputDir, "README.md"), "utf-8");
    expect(readme).toContain("example.com");
    expect(readme).toContain("react");

    const pkg = JSON.parse(await readFile(path.join(outputDir, "package.json"), "utf-8"));
    expect(pkg.studyClone.detectedFramework).toEqual(["react"]);

    // Provenance marker must exist and be valid JSON with the study mode flag.
    const marker = JSON.parse(await readFile(path.join(outputDir, ".study-clone"), "utf-8"));
    expect(marker.mode).toBe("study");

    // filesWritten should actually correspond to real files, not be a
    // list that drifted from what was truly written to disk.
    for (const relativePath of result.filesWritten) {
      await expect(
        access(path.join(outputDir, relativePath)),
        `Expected ${relativePath} to exist on disk`
      ).resolves.toBeUndefined();
    }
  });

  it("warns but does not throw when a page yields no inferable components", async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), "fsc-study-test-"));
    const flatCapture: CaptureResult = {
      ...makeCapture(),
      pages: [
        {
          url: "https://example.com/",
          viewport: VIEWPORT,
          renderedHtml: "<html><body><span>just text</span></body></html>",
          computedStyles: [],
        },
      ],
    };

    const result = await assembleStudyMode(flatCapture, {
      outputDir,
      gsapDetected: false,
      threeSceneIntrospectable: false,
    });

    expect(result.componentCount).toBe(0);
    expect(result.warnings.some((w) => w.includes("No components were inferred"))).toBe(true);

    // The page file itself should still be written completely, even
    // with zero extractable components — Study mode must degrade
    // gracefully, never producing a broken or empty output.
    const homeHtml = await readFile(path.join(outputDir, "src/pages/home.html"), "utf-8");
    expect(homeHtml).toContain("just text");
  });
});
