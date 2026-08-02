import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRunMode } from "../src/assemble/writeRunMode.js";
import type { CaptureResult } from "../src/types/index.js";

const VIEWPORT = { name: "desktop", width: 1440, height: 900 };

function makeCapture(): CaptureResult {
  return {
    targetUrl: "https://example.com/",
    capturedAt: new Date().toISOString(),
    pages: [
      {
        url: "https://example.com/",
        viewport: VIEWPORT,
        renderedHtml: `<html><body><a href="https://example.com/about">About</a></body></html>`,
        computedStyles: [],
      },
      {
        url: "https://example.com/about",
        viewport: VIEWPORT,
        renderedHtml: `<html><body><a href="https://example.com/">Home</a></body></html>`,
        computedStyles: [],
      },
    ],
    assets: [],
    sourceMaps: [],
    framework: { frameworks: ["unknown"], cssApproach: "unknown" },
    externalDependencies: [],
  };
}

describe("writeRunMode — multi-page cross-linking", () => {
  let outputDir: string;

  afterEach(async () => {
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
  });

  it("rewrites links between two crawled pages to local relative paths, not the original absolute URLs", async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), "fsc-test-"));
    await writeRunMode(makeCapture(), { outputDir });

    // Sub-page links use clean directory URLs (/about/) not file paths (/about/index.html)
    const indexHtml = await readFile(path.join(outputDir, "index.html"), "utf-8");
    const aboutHtml = await readFile(path.join(outputDir, "about", "index.html"), "utf-8");

    // index.html links to /about/ (clean URL, not /about/index.html)
    expect(indexHtml).toContain('href="/about/"');
    expect(indexHtml).not.toContain("https://example.com/about");

    // about/index.html links back to root — root index.html is the exception,
    // it stays as /index.html since there is no cleaner root URL
    expect(aboutHtml).toContain('href="/index.html"');
    expect(aboutHtml).not.toContain("https://example.com/");
  });
});

describe("writeRunMode — RSC asset vs page directory write-order race", () => {
  let outputDir: string;

  afterEach(async () => {
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
  });

  it("writes about/index.html as a real directory even when an RSC fetch asset shares the page's pathname", async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), "fsc-test-"));

    const capture: CaptureResult = {
      targetUrl: "https://example.com/",
      capturedAt: new Date().toISOString(),
      pages: [
        {
          url: "https://example.com/",
          viewport: VIEWPORT,
          renderedHtml: `<html><body><a href="https://example.com/about">About</a></body></html>`,
          computedStyles: [],
        },
        {
          url: "https://example.com/about",
          viewport: VIEWPORT,
          renderedHtml: `<html><body>About page content</body></html>`,
          computedStyles: [],
        },
      ],
      // Simulates a Next.js RSC fetch for the same route, which carries a
      // "?_rsc=<hash>" query string and would (absent the pagePathKey
      // filter in writeRunMode) get assigned the local path "about" — a
      // FILE — colliding with the "about/" DIRECTORY the page document
      // needs. If this asset is written before the page's directory is
      // created, safeMkdir("about/") would previously race against it.
      assets: [
        {
          url: "https://example.com/about?_rsc=abc123",
          type: "other",
          status: 200,
          discoveredViaInteraction: false,
          buffer: Buffer.from('{"rsc":"payload"}'),
        },
      ],
      sourceMaps: [],
      framework: { frameworks: ["next"], cssApproach: "unknown" },
      externalDependencies: [],
    };

    const result = await writeRunMode(capture, { outputDir });

    // No warnings — the page HTML was successfully written as a directory.
    expect(result.warnings).toHaveLength(0);

    // about/index.html exists and contains the real page content, proving
    // "about" is a directory, not the RSC JSON file.
    const aboutHtml = await readFile(path.join(outputDir, "about", "index.html"), "utf-8");
    expect(aboutHtml).toContain("About page content");

    // The RSC asset must NOT have clobbered the page — it should be
    // filtered out entirely (see pagePathKey matching in writeRunMode),
    // so no stray "about" file should exist alongside the directory.
    const aboutStat = await stat(path.join(outputDir, "about"));
    expect(aboutStat.isDirectory()).toBe(true);
  });
});
