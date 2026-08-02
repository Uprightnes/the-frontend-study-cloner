/**
 * Tests for improvements: Google Fonts bundling, video poster capture,
 * and serving config completeness.
 */

import { describe, it, expect } from "vitest";
import { isGoogleFontsCssUrl, isGoogleFontsFileUrl } from "../src/assemble/googleFonts.js";

// ─── Google Fonts detection ──────────────────────────────────────────────────

describe("isGoogleFontsCssUrl", () => {
  it("identifies Google Fonts CSS API URLs", () => {
    expect(
      isGoogleFontsCssUrl("https://fonts.googleapis.com/css2?family=Inter:wght@400;700")
    ).toBe(true);
    expect(
      isGoogleFontsCssUrl("https://fonts.googleapis.com/css?family=Roboto")
    ).toBe(true);
  });

  it("rejects non-Google-Fonts URLs", () => {
    expect(isGoogleFontsCssUrl("https://example.com/fonts/inter.css")).toBe(false);
    expect(isGoogleFontsCssUrl("https://fonts.gstatic.com/s/inter/v13/abc.woff2")).toBe(false);
  });

  it("rejects Google Fonts URLs that are not CSS endpoints", () => {
    expect(isGoogleFontsCssUrl("https://fonts.googleapis.com/icon?family=Material+Icons")).toBe(false);
  });
});

describe("isGoogleFontsFileUrl", () => {
  it("identifies Google Fonts file URLs", () => {
    expect(
      isGoogleFontsFileUrl("https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2")
    ).toBe(true);
  });

  it("rejects non-gstatic URLs", () => {
    expect(isGoogleFontsFileUrl("https://fonts.googleapis.com/css2?family=Inter")).toBe(false);
    expect(isGoogleFontsFileUrl("https://example.com/fonts/inter.woff2")).toBe(false);
  });
});
