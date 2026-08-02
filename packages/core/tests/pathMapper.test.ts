import { describe, it, expect } from "vitest";
import { buildPathMappings } from "../src/assemble/pathMapper.js";
import type { CapturedAsset } from "../src/types/index.js";

function asset(url: string, type: CapturedAsset["type"] = "image"): CapturedAsset {
  return { url, type, status: 200, discoveredViaInteraction: false, buffer: Buffer.from("x") };
}

describe("buildPathMappings", () => {
  it("maps a simple path-based URL to an analogous local path", () => {
    const mappings = buildPathMappings([asset("https://example.com/logo.png")]);
    expect(mappings.get("https://example.com/logo.png")?.localPath).toBe(
      "assets/images/logo.png"
    );
  });

  it("gives the document root URL an index.html-style name", () => {
    const mappings = buildPathMappings([asset("https://example.com/", "document")]);
    const mapping = mappings.get("https://example.com/");
    expect(mapping?.localPath).toBe("index.html");
  });

  it("normalizes extension based on captured type, not URL extension", () => {
    // A route like "/about" with no extension, captured as a document.
    // Written as about/index.html (not about.html) so relative asset paths
    // work correctly when served at /about/ with a trailing slash.
    const mappings = buildPathMappings(
      [asset("https://example.com/about", "document")],
      { preserveStructure: true }
    );
    expect(mappings.get("https://example.com/about")?.localPath).toBe("about/index.html");
  });

  it("disambiguates colliding paths instead of silently overwriting", () => {
    // This is the exact four-URL collision scenario described in the
    // source chapter (case difference, forbidden character, wrong
    // extension all converging on "index_1.html").
    const assets = [
      asset("https://example.com/index_1.html", "document"),
      asset("https://example.com/INDEX_1.HTML", "document"),
      asset("https://example.com/index:1.html", "document"),
      asset("https://example.com/index_1.cgi", "document"),
    ];
    const mappings = buildPathMappings(assets);
    const localPaths = assets.map((a) => mappings.get(a.url)!.localPath);

    // All four must resolve to genuinely distinct files on disk.
    expect(new Set(localPaths).size).toBe(4);
  });

  it("sanitizes filesystem-unsafe characters", () => {
    const mappings = buildPathMappings([
      asset("https://example.com/weird:name?.png"),
    ]);
    const localPath = mappings.get("https://example.com/weird:name?.png")!.localPath;
    expect(localPath).not.toMatch(/[:?]/);
  });

  it("keeps script and stylesheet assets in their own folders", () => {
    const mappings = buildPathMappings([
      asset("https://example.com/main.js", "script"),
      asset("https://example.com/style.css", "stylesheet"),
    ]);
    expect(mappings.get("https://example.com/main.js")?.localPath).toMatch(/^assets\/js\//);
    expect(mappings.get("https://example.com/style.css")?.localPath).toMatch(/^assets\/css\//);
  });
});
