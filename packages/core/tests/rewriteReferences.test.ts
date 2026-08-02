import { describe, it, expect } from "vitest";
import { rewriteJsStringLiterals } from "../src/assemble/rewriteReferences.js";
import type { PathMapping } from "../src/assemble/pathMapper.js";

function mappingsFor(pairs: Array<[string, string]>): Map<string, PathMapping> {
  const map = new Map<string, PathMapping>();
  for (const [originalUrl, localPath] of pairs) {
    map.set(originalUrl, { originalUrl, localPath });
  }
  return map;
}

describe("rewriteJsStringLiterals", () => {
  it("rewrites an exact absolute-URL string literal", () => {
    const js = `foo.src = "https://example.com/images/welcome.gif";`;
    const mappings = mappingsFor([
      ["https://example.com/images/welcome.gif", "assets/images/welcome.gif"],
    ]);
    const { rewritten, replacementCount } = rewriteJsStringLiterals(
      js,
      mappings,
      "assets/js/main.js"
    );
    expect(replacementCount).toBe(1);
    expect(rewritten).toContain("../images/welcome.gif");
    expect(rewritten).not.toContain("https://example.com");
  });

  it("does NOT touch a concatenated/constructed string, per the chapter's own example", () => {
    // This is directly the "foo.src = dir + /images/welcome.gif" example
    // from the source chapter — the relative path here is NOT a complete
    // absolute URL literal, so it should never match our pattern at all,
    // and must be left completely untouched.
    const js = `foo.src = dir + "/images/welcome.gif";`;
    const mappings = mappingsFor([
      ["https://example.com/images/welcome.gif", "assets/images/welcome.gif"],
    ]);
    const { rewritten, replacementCount } = rewriteJsStringLiterals(
      js,
      mappings,
      "assets/js/main.js"
    );
    expect(replacementCount).toBe(0);
    expect(rewritten).toBe(js);
  });

  it("does not rewrite a URL that merely appears as a substring of a longer literal", () => {
    const js = `const note = "see https://example.com/images/welcome.gif for reference";`;
    const mappings = mappingsFor([
      ["https://example.com/images/welcome.gif", "assets/images/welcome.gif"],
    ]);
    const { replacementCount } = rewriteJsStringLiterals(js, mappings, "assets/js/main.js");
    // The literal as a whole ("see ...gif for reference") is not an
    // exact match for the known URL, so our conservative pattern
    // (anchored to matching quote characters immediately around the URL)
    // correctly leaves this alone too.
    expect(replacementCount).toBe(0);
  });

  it("handles multiple distinct known URLs in the same bundle", () => {
    const js = `var a="https://example.com/a.png",b="https://example.com/b.png";`;
    const mappings = mappingsFor([
      ["https://example.com/a.png", "assets/images/a.png"],
      ["https://example.com/b.png", "assets/images/b.png"],
    ]);
    const { replacementCount } = rewriteJsStringLiterals(js, mappings, "assets/js/main.js");
    expect(replacementCount).toBe(2);
  });

  it("does NOT rewrite document (HTML page) URLs — they corrupt webpack publicPath", () => {
    // This is the exact bug that caused 'Unexpected token <' on all JS files.
    // The webpack runtime bundle contains:
    //   __webpack_require__.p = "https://example.com/"
    // which it uses to construct all chunk URLs. If we rewrite this to a
    // relative path like "../../../index.html", webpack builds nonsense
    // chunk URLs and every dynamic import fails with Unexpected token '<'.
    const js = `__webpack_require__.p="https://example.com/";`;
    const mappings = mappingsFor([
      ["https://example.com/", "index.html"],
      ["https://example.com/about", "about/index.html"],
      ["https://example.com/images/logo.png", "images/logo.png"],
    ]);
    const { rewritten, replacementCount } = rewriteJsStringLiterals(
      js,
      mappings,
      "_next/static/chunks/webpack-abc123.js"
    );
    // Document URLs must NOT be rewritten — only non-document assets
    expect(rewritten).toContain("https://example.com/");
    expect(rewritten).not.toContain("index.html");
    expect(replacementCount).toBe(0);
  });

  it("still rewrites non-document asset URLs in JS (images, fonts, etc.)", () => {
    const js = `var logo="https://example.com/images/logo.png";`;
    const mappings = mappingsFor([
      ["https://example.com/", "index.html"],
      ["https://example.com/images/logo.png", "images/logo.png"],
    ]);
    const { rewritten, replacementCount } = rewriteJsStringLiterals(
      js,
      mappings,
      "_next/static/chunks/main.js"
    );
    // Image URL should be rewritten, origin URL should not
    expect(replacementCount).toBe(1);
    expect(rewritten).not.toContain("https://example.com/images/logo.png");
    expect(rewritten).toContain("images/logo.png");
  });

  it("is a no-op when there are no known absolute URLs to rewrite", () => {
    const js = `console.log("hello world");`;
    const { rewritten, replacementCount } = rewriteJsStringLiterals(
      js,
      new Map(),
      "assets/js/main.js"
    );
    expect(replacementCount).toBe(0);
    expect(rewritten).toBe(js);
  });
});
