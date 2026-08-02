/**
 * Regression tests for three confirmed Run-mode bugs on Next.js App Router sites.
 *
 * Bug 1 — pathMapper reorganizes assets in Run mode, breaking Next.js
 *   Fix: preserveStructure: true in buildPathMappings keeps /_next/static/...
 *        at its original path so framework-internal chunk-loader references work.
 *
 * Bug 2 — Next.js Image Optimization API URLs never resolve locally
 *   Fix: synthesizeDirectImageAssets decodes /_next/image?url=... and registers
 *        the underlying image at its decoded path; rewriteNextImageUrls patches
 *        HTML src/srcset attributes to point at those decoded paths.
 *
 * Bug 3 — RSC flight protocol asset references not captured
 *   Fix: scanRscFlightReferences extracts :HL[...] directives from inline
 *        <script> tags and returns URLs absent from the existing asset set.
 */

import { describe, it, expect } from "vitest";
import { buildPathMappings, type BuildPathMappingsOptions } from "../src/assemble/pathMapper.js";
import {
  isNextImageUrl,
  decodeNextImageUrl,
  synthesizeDirectImageAssets,
  rewriteNextImageUrls,
} from "../src/assemble/nextImageDecoder.js";
import { scanRscFlightReferences } from "../src/assemble/rscAssetScanner.js";
import type { CapturedAsset } from "../src/types/index.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAsset(url: string, type: CapturedAsset["type"], bufferSize = 100): CapturedAsset {
  return {
    url,
    type,
    buffer: Buffer.alloc(bufferSize, 0xab),
    status: 200,
    discoveredViaInteraction: false,
  };
}

// ─── Bug 1: preserveStructure ────────────────────────────────────────────────

describe("Bug 1: pathMapper preserveStructure", () => {
  it("without preserveStructure, _next/static paths are reorganised into assets/css/", () => {
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/_next/static/css/abc123.css", "stylesheet"),
    ];
    const mappings = buildPathMappings(assets); // default: preserveStructure false
    const mapping = mappings.get("https://example.com/_next/static/css/abc123.css")!;
    // Under Study-mode layout the file is moved under assets/css/
    expect(mapping.localPath).toContain("assets/css");
    expect(mapping.localPath).not.toBe("_next/static/css/abc123.css");
  });

  it("with preserveStructure: true, _next/static/css paths are kept verbatim", () => {
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/_next/static/css/abc123.css", "stylesheet"),
    ];
    const mappings = buildPathMappings(assets, { preserveStructure: true });
    const mapping = mappings.get("https://example.com/_next/static/css/abc123.css")!;
    expect(mapping.localPath).toBe("_next/static/css/abc123.css");
  });

  it("with preserveStructure: true, JS chunk paths are kept verbatim", () => {
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/_next/static/chunks/pages/index-deadbeef.js", "script"),
    ];
    const mappings = buildPathMappings(assets, { preserveStructure: true });
    const mapping = mappings.get(
      "https://example.com/_next/static/chunks/pages/index-deadbeef.js"
    )!;
    expect(mapping.localPath).toBe("_next/static/chunks/pages/index-deadbeef.js");
  });

  it("with preserveStructure: true, image paths are kept verbatim", () => {
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/images/hero.png", "image"),
    ];
    const mappings = buildPathMappings(assets, { preserveStructure: true });
    const mapping = mappings.get("https://example.com/images/hero.png")!;
    expect(mapping.localPath).toBe("images/hero.png");
  });

  it("with preserveStructure: true, root document maps to index.html", () => {
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/", "document"),
    ];
    const mappings = buildPathMappings(assets, { preserveStructure: true });
    const mapping = mappings.get("https://example.com/")!;
    expect(mapping.localPath).toBe("index.html");
  });

  it("with preserveStructure: true, sub-page documents become dir/index.html", () => {
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/about", "document"),
    ];
    const mappings = buildPathMappings(assets, { preserveStructure: true });
    const mapping = mappings.get("https://example.com/about")!;
    expect(mapping.localPath).toBe("about/index.html");
  });

  it("with preserveStructure: true, collision is resolved with a hash suffix", () => {
    // Two different URLs that map to the same decoded path
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/_next/static/css/abc.css", "stylesheet"),
      makeAsset("https://other.com/_next/static/css/abc.css", "stylesheet"),
    ];
    const mappings = buildPathMappings(assets, { preserveStructure: true });
    const paths = Array.from(mappings.values()).map((m) => m.localPath);
    // Both should be present and distinct
    expect(new Set(paths).size).toBe(2);
  });
});

// ─── Bug 2: Next.js Image Decoder ───────────────────────────────────────────

describe("Bug 2: isNextImageUrl", () => {
  it("identifies /_next/image API URLs", () => {
    expect(
      isNextImageUrl("https://example.com/_next/image?url=%2Fimages%2Fhero.png&w=1200&q=75")
    ).toBe(true);
  });

  it("rejects ordinary image URLs", () => {
    expect(isNextImageUrl("https://example.com/images/hero.png")).toBe(false);
  });

  it("rejects non-/_next/image paths even with url param", () => {
    expect(isNextImageUrl("https://example.com/api/image?url=foo")).toBe(false);
  });
});

describe("Bug 2: decodeNextImageUrl", () => {
  const origin = "https://example.com";

  it("decodes a root-relative url param to an absolute URL", () => {
    const apiUrl = "https://example.com/_next/image?url=%2Fimages%2Fhero.png&w=1200&q=75";
    expect(decodeNextImageUrl(apiUrl, origin)).toBe("https://example.com/images/hero.png");
  });

  it("decodes an absolute CDN url param", () => {
    const apiUrl =
      "https://example.com/_next/image?url=https%3A%2F%2Fcdn.sanity.io%2Fimages%2Fabc.jpg&w=3840&q=80";
    expect(decodeNextImageUrl(apiUrl, origin)).toBe(
      "https://cdn.sanity.io/images/abc.jpg"
    );
  });

  it("returns null for non-/_next/image URLs", () => {
    expect(decodeNextImageUrl("https://example.com/foo.png", origin)).toBeNull();
  });
});

describe("Bug 2: synthesizeDirectImageAssets", () => {
  const origin = "https://example.com";

  it("returns a synthesized asset at the decoded URL", () => {
    const assets: CapturedAsset[] = [
      makeAsset(
        "https://example.com/_next/image?url=%2Fimages%2Fhero.png&w=1200&q=75",
        "image",
        5000
      ),
    ];
    const synthesized = synthesizeDirectImageAssets(assets, origin);
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]!.url).toBe("https://example.com/images/hero.png");
    expect(synthesized[0]!.type).toBe("image");
  });

  it("deduplicates multiple width variants, keeping the largest buffer", () => {
    const smallBuffer = Buffer.alloc(100);
    const largeBuffer = Buffer.alloc(50000);
    const assets: CapturedAsset[] = [
      {
        url: "https://example.com/_next/image?url=%2Fimages%2Fhero.png&w=640&q=75",
        type: "image",
        buffer: smallBuffer,
        status: 200,
        discoveredViaInteraction: false,
      },
      {
        url: "https://example.com/_next/image?url=%2Fimages%2Fhero.png&w=3840&q=75",
        type: "image",
        buffer: largeBuffer,
        status: 200,
        discoveredViaInteraction: false,
      },
    ];
    const synthesized = synthesizeDirectImageAssets(assets, origin);
    // Two different width URLs → same decoded URL → one synthesized entry
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]!.buffer?.length).toBe(50000);
  });

  it("skips /_next/image assets that have no buffer", () => {
    const assets: CapturedAsset[] = [
      {
        url: "https://example.com/_next/image?url=%2Fimages%2Fhero.png&w=640&q=75",
        type: "image",
        buffer: undefined,
        status: 404,
        discoveredViaInteraction: false,
      },
    ];
    const synthesized = synthesizeDirectImageAssets(assets, origin);
    expect(synthesized).toHaveLength(0);
  });

  it("ignores non-/_next/image assets", () => {
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/images/hero.png", "image"),
    ];
    const synthesized = synthesizeDirectImageAssets(assets, origin);
    expect(synthesized).toHaveLength(0);
  });
});

describe("Bug 2: rewriteNextImageUrls", () => {
  const origin = "https://example.com";

  it("rewrites src attribute containing a /_next/image URL", () => {
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/images/hero.png", "image"),
    ];
    const mappings = buildPathMappings(assets, { preserveStructure: true });

    const html = `<img src="/_next/image?url=%2Fimages%2Fhero.png&w=1200&q=75" alt="hero">`;
    const result = rewriteNextImageUrls(html, "index.html", origin, mappings);
    // rewriteNextImageUrls uses root-relative paths so they work from any depth
    expect(result).toContain('src="/images/hero.png"');
    expect(result).not.toContain("/_next/image");
  });

  it("rewrites srcset attribute with multiple /_next/image entries", () => {
    const assets: CapturedAsset[] = [
      makeAsset("https://example.com/images/hero.png", "image"),
    ];
    const mappings = buildPathMappings(assets, { preserveStructure: true });

    const html = `<img srcset="/_next/image?url=%2Fimages%2Fhero.png&w=640&q=75 640w, /_next/image?url=%2Fimages%2Fhero.png&w=1280&q=75 1280w">`;
    const result = rewriteNextImageUrls(html, "index.html", origin, mappings);
    expect(result).not.toContain("/_next/image");
    // Both entries should now be the decoded path with their descriptors
    expect(result).toContain("640w");
    expect(result).toContain("1280w");
    expect(result).toMatch(/images\/hero\.png.*640w/);
  });

  it("leaves /_next/image src alone if the decoded URL has no mapping", () => {
    const mappings = new Map();
    const html = `<img src="/_next/image?url=%2Fimages%2Funknown.png&w=1200&q=75">`;
    const result = rewriteNextImageUrls(html, "index.html", origin, mappings);
    // No mapping → leave original in place
    expect(result).toContain("/_next/image");
  });
});

// ─── Bug 3: RSC flight asset scanner ────────────────────────────────────────

describe("Bug 3: scanRscFlightReferences", () => {
  const origin = "https://example.com";

  it("extracts a style HL reference from RSC flight script tag", () => {
    const html = `
      <html><body>
      <script>self.__next_f.push([1,":HL[\\\"/_next/static/css/abc123.css\\\",\\\"style\\\"]"])</script>
      </body></html>`;
    const missing = scanRscFlightReferences(html, new Set(), origin);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.url).toBe("https://example.com/_next/static/css/abc123.css");
    expect(missing[0]!.hintType).toBe("style");
  });

  it("extracts a script HL reference", () => {
    const html = `<script>self.__next_f.push([1,":HL[\\\"/_next/static/chunks/main.js\\\",\\\"script\\\"]"])</script>`;
    const missing = scanRscFlightReferences(html, new Set(), origin);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.url).toBe("https://example.com/_next/static/chunks/main.js");
    expect(missing[0]!.hintType).toBe("script");
  });

  it("skips URLs already present in existingAssetUrls", () => {
    const html = `<script>self.__next_f.push([1,":HL[\\\"/_next/static/css/abc123.css\\\",\\\"style\\\"]"])</script>`;
    const existing = new Set(["https://example.com/_next/static/css/abc123.css"]);
    const missing = scanRscFlightReferences(html, existing, origin);
    expect(missing).toHaveLength(0);
  });

  it("deduplicates the same URL appearing multiple times in RSC data", () => {
    const ref = `:HL[\\\"/_next/static/css/abc123.css\\\",\\\"style\\\"]`;
    const html = `<script>self.__next_f.push([1,"${ref}${ref}"])</script>`;
    const missing = scanRscFlightReferences(html, new Set(), origin);
    expect(missing).toHaveLength(1);
  });

  it("returns empty array when no RSC HL directives are present", () => {
    const html = `<html><head><link rel="stylesheet" href="/app.css"></head></html>`;
    const missing = scanRscFlightReferences(html, new Set(), origin);
    expect(missing).toHaveLength(0);
  });

  it("handles multiple HL references in one script block", () => {
    const html = `<script>self.__next_f.push([1,
      ":HL[\\\"/_next/static/css/a.css\\\",\\\"style\\\"] :HL[\\\"/_next/static/css/b.css\\\",\\\"style\\\"]"
    ])</script>`;
    const missing = scanRscFlightReferences(html, new Set(), origin);
    expect(missing).toHaveLength(2);
  });

  it("ignores script tags that contain no RSC flight data", () => {
    const html = `
      <script>window.ga = function(){};</script>
      <script>self.__next_f.push([1,":HL[\\\"/_next/static/css/real.css\\\",\\\"style\\\"]"])</script>`;
    const missing = scanRscFlightReferences(html, new Set(), origin);
    expect(missing).toHaveLength(1);
  });
});
