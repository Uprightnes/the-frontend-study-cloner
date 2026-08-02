/**
 * Tests for Phase 2 (visual diff) and Phase 3 (multi-page serving config).
 *
 * Phase 2: visualDiff.ts — we can't test the Playwright screenshot logic in
 * unit tests, but we test the static file server and the URL path resolution.
 *
 * Phase 3: servingConfig.ts — verifies that per-page clean-URL rewrites are
 * generated correctly for multi-page captures, and that single-page captures
 * still produce a simple SPA-fallback-only config.
 */

import { describe, it, expect } from "vitest";
import { writeServingConfig } from "../src/assemble/servingConfig.js";
import type { CaptureResult, CapturedPage, Viewport } from "../src/types/index.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeViewport(name: string): Viewport {
  return { name, width: 1440, height: 900 };
}

function makePage(url: string): CapturedPage {
  return {
    url,
    viewport: makeViewport("desktop"),
    renderedHtml: `<html><body><a href="${url}">link</a></body></html>`,
    computedStyles: [],
  };
}

function makeCaptureResult(urls: string[]): CaptureResult {
  return {
    targetUrl: urls[0]!,
    capturedAt: new Date().toISOString(),
    pages: urls.map(makePage),
    assets: [],
    sourceMaps: [],
    framework: { frameworks: ["next"], cssApproach: "tailwind" },
    externalDependencies: [],
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fsc-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ─── Phase 3: servingConfig ──────────────────────────────────────────────────

describe("Phase 3: writeServingConfig — single page", () => {
  it("writes serve.json, _redirects, vercel.json, SERVING.md", async () => {
    await withTempDir(async (dir) => {
      const capture = makeCaptureResult(["https://example.com/"]);
      const files = await writeServingConfig(dir, capture);
      expect(files).toContain("serve.json");
      expect(files).toContain("_redirects");
      expect(files).toContain("vercel.json");
      expect(files).toContain("SERVING.md");
    });
  });

  it("single page: serve.json has no rewrites (no catch-all — see recursion-bug note)", async () => {
    await withTempDir(async (dir) => {
      const capture = makeCaptureResult(["https://example.com/"]);
      await writeServingConfig(dir, capture);
      const serveJson = JSON.parse(await readFile(join(dir, "serve.json"), "utf-8"));
      // No per-page rewrites (root has none) and no catch-all — serve's own
      // default static resolution already serves index.html at "/".
      expect(serveJson.rewrites).toHaveLength(0);
    });
  });
});

describe("Phase 3: writeServingConfig — multi-page", () => {
  it("generates per-page rewrites for each sub-page", async () => {
    await withTempDir(async (dir) => {
      const capture = makeCaptureResult([
        "https://example.com/",
        "https://example.com/about",
        "https://example.com/work",
      ]);
      await writeServingConfig(dir, capture);
      const serveJson = JSON.parse(await readFile(join(dir, "serve.json"), "utf-8"));

      // Each sub-page gets TWO rewrites (with and without trailing slash);
      // NO catch-all — 2 pages * 2 = 4
      expect(serveJson.rewrites).toHaveLength(4);

      const sources = serveJson.rewrites.map((r: { source: string }) => r.source);
      expect(sources).toContain("/about");
      expect(sources).toContain("/about/");
      expect(sources).toContain("/work");
      expect(sources).toContain("/work/");

      const destinations = serveJson.rewrites.map((r: { destination: string }) => r.destination);
      expect(destinations).toContain("/about/index.html");
      expect(destinations).toContain("/work/index.html");

      // Regression guard: serve.json must NEVER contain a catch-all rule.
      // serve-handler applies rewrites recursively — after a specific rule
      // matches and rewrites the path, it re-runs remaining rules against
      // the NEW path, and "**" matches anything, so it would silently
      // rewrite every specific page back to "/index.html" on that second
      // pass. Confirmed by reproducing against an actual captured
      // multi-page site: with a catch-all present, every specific page URL
      // (with or without trailing slash) served the homepage instead.
      expect(sources).not.toContain("**");
      expect(sources.some((s: string) => s.includes("(.*)"))).toBe(false);
    });
  });

  it("generates _redirects with per-page entries for Netlify", async () => {
    await withTempDir(async (dir) => {
      const capture = makeCaptureResult([
        "https://example.com/",
        "https://example.com/contact",
      ]);
      await writeServingConfig(dir, capture);
      const redirects = await readFile(join(dir, "_redirects"), "utf-8");
      expect(redirects).toContain("/contact  /contact/index.html  200");
      expect(redirects).toContain("/contact/  /contact/index.html  200");
      // SPA fallback last
      expect(redirects).toContain("/*  /index.html  200");
    });
  });

  it("generates vercel.json with per-page rewrites", async () => {
    await withTempDir(async (dir) => {
      const capture = makeCaptureResult([
        "https://example.com/",
        "https://example.com/blog",
      ]);
      await writeServingConfig(dir, capture);
      const vercelJson = JSON.parse(await readFile(join(dir, "vercel.json"), "utf-8"));
      const sources = vercelJson.rewrites.map((r: { source: string }) => r.source);
      expect(sources).toContain("/blog");
    });
  });

  it("SERVING.md mentions the correct page count", async () => {
    await withTempDir(async (dir) => {
      const capture = makeCaptureResult([
        "https://example.com/",
        "https://example.com/about",
        "https://example.com/work",
      ]);
      await writeServingConfig(dir, capture);
      const md = await readFile(join(dir, "SERVING.md"), "utf-8");
      // 3 pages total: /, /about, /work
      expect(md).toContain("3 page(s)");
    });
  });

  it("does not add a rewrite for the homepage (/ handled by index.html)", async () => {
    await withTempDir(async (dir) => {
      const capture = makeCaptureResult([
        "https://example.com/",
        "https://example.com/about",
      ]);
      await writeServingConfig(dir, capture);
      const serveJson = JSON.parse(await readFile(join(dir, "serve.json"), "utf-8"));
      const sources = serveJson.rewrites.map((r: { source: string }) => r.source);
      // / should not appear as a separate rewrite — it IS index.html
      expect(sources).not.toContain("/");
    });
  });

  it("works without a capture argument (backward compatibility)", async () => {
    await withTempDir(async (dir) => {
      const files = await writeServingConfig(dir);
      expect(files).toContain("serve.json");
      const serveJson = JSON.parse(await readFile(join(dir, "serve.json"), "utf-8"));
      // No pages known, no catch-all — empty rewrites array.
      expect(serveJson.rewrites).toHaveLength(0);
    });
  });
});
