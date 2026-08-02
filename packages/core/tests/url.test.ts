import { describe, it, expect } from "vitest";
import { isSameOrigin, normalizeUrlForDedupe } from "../src/utils/url.js";

describe("isSameOrigin", () => {
  it("treats identical origins as same-origin", () => {
    expect(isSameOrigin("https://example.com/", "https://example.com/about")).toBe(true);
  });

  it("rejects a different host", () => {
    expect(isSameOrigin("https://example.com/", "https://evil.com/about")).toBe(false);
  });

  it("rejects a different scheme even on the same host", () => {
    expect(isSameOrigin("https://example.com/", "http://example.com/about")).toBe(false);
  });

  it("rejects a different port", () => {
    expect(isSameOrigin("https://example.com/", "https://example.com:8080/about")).toBe(false);
  });

  it("resolves a relative candidate URL against the base before comparing", () => {
    expect(isSameOrigin("https://example.com/blog/post-1", "/about")).toBe(true);
  });

  it("resolves a bare relative-looking string against the base origin (this is correct per the URL spec, not a bug)", () => {
    // "not a url at all" is technically a valid relative path segment;
    // new URL() resolves it against the base exactly as a browser would
    // resolve a malformed-looking but technically-valid href. This is
    // expected behavior, not a parsing failure — the resulting URL is
    // genuinely same-origin (it would just 404 if actually requested).
    expect(isSameOrigin("https://example.com/", "not a url at all")).toBe(true);
  });

  it("returns false for a candidate that is not parseable as a URL at all", () => {
    // An absolute-looking but genuinely invalid URL (here, an invalid
    // protocol with no valid authority structure) should fail to parse
    // and fall through to the catch block, rather than for instance
    // resolving against the base in some surprising way.
    expect(isSameOrigin("https://example.com/", "http://")).toBe(false);
  });
});

describe("normalizeUrlForDedupe", () => {
  it("strips the fragment", () => {
    expect(normalizeUrlForDedupe("https://example.com/about#team")).toBe(
      "https://example.com/about"
    );
  });

  it("removes a trailing slash on a non-root path", () => {
    expect(normalizeUrlForDedupe("https://example.com/about/")).toBe(
      "https://example.com/about"
    );
  });

  it("keeps the root path slash intact", () => {
    expect(normalizeUrlForDedupe("https://example.com/")).toBe("https://example.com/");
  });

  it("treats a trailing-slash and non-trailing-slash variant as the same normalized URL", () => {
    const a = normalizeUrlForDedupe("https://example.com/about");
    const b = normalizeUrlForDedupe("https://example.com/about/");
    expect(a).toBe(b);
  });

  it("treats a fragment-only difference as the same normalized URL", () => {
    const a = normalizeUrlForDedupe("https://example.com/about#team");
    const b = normalizeUrlForDedupe("https://example.com/about#contact");
    expect(a).toBe(b);
  });
});
