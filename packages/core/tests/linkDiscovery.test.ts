import { describe, it, expect } from "vitest";
import { discoverSameOriginLinks, extractLinksFromHtml } from "../src/capture/linkDiscovery.js";
import type { Page } from "playwright";

/**
 * Builds a minimal mock satisfying the Page methods discoverSameOriginLinks
 * actually calls, including the new waitForTimeout and evaluate-based scroll
 * pass added for hydration settling and lazy-link discovery.
 */
function mockPage(hrefs: string[], currentUrl: string): Page {
  return {
    // evaluate is called twice: once for the scroll pass (returns undefined),
    // once for the href extraction (returns hrefs). We detect which call by
    // checking whether the callback references scrollBy (scroll pass).
    evaluate: async (fn: Function) => {
      const fnStr = fn.toString();
      if (fnStr.includes("scrollBy") || fnStr.includes("scrollTo")) {
        // Scroll pass — return nothing (void)
        return undefined;
      }
      // Link extraction pass
      return hrefs;
    },
    url: () => currentUrl,
    waitForTimeout: async () => undefined,
  } as unknown as Page;
}

describe("discoverSameOriginLinks", () => {
  it("returns same-origin links, normalized", async () => {
    const page = mockPage(
      ["https://example.com/about", "https://example.com/contact/"],
      "https://example.com/"
    );
    const links = await discoverSameOriginLinks(page, "https://example.com/");
    expect(links.sort()).toEqual(
      ["https://example.com/about", "https://example.com/contact"].sort()
    );
  });

  it("excludes cross-origin links", async () => {
    const page = mockPage(
      ["https://example.com/about", "https://evil.com/phishing"],
      "https://example.com/"
    );
    const links = await discoverSameOriginLinks(page, "https://example.com/");
    expect(links).toEqual(["https://example.com/about"]);
  });

  it("excludes mailto, tel, and javascript pseudo-links", async () => {
    const page = mockPage(
      [
        "mailto:hello@example.com",
        "tel:+15555555555",
        "javascript:void(0)",
        "https://example.com/real-page",
      ],
      "https://example.com/"
    );
    const links = await discoverSameOriginLinks(page, "https://example.com/");
    expect(links).toEqual(["https://example.com/real-page"]);
  });

  it("excludes a pure fragment difference on the current page itself", async () => {
    const page = mockPage(
      ["https://example.com/about#team", "https://example.com/about#contact"],
      "https://example.com/about"
    );
    const links = await discoverSameOriginLinks(page, "https://example.com/");
    expect(links).toEqual([]);
  });

  it("deduplicates links that normalize to the same URL", async () => {
    const page = mockPage(
      ["https://example.com/about", "https://example.com/about/", "https://example.com/about#x"],
      "https://example.com/"
    );
    const links = await discoverSameOriginLinks(page, "https://example.com/");
    expect(links).toEqual(["https://example.com/about"]);
  });

  it("excludes font and static asset URLs from the crawl queue", async () => {
    const page = mockPage(
      [
        "https://example.com/about",
        "https://example.com/_next/static/media/font.woff2",
        "https://example.com/_next/static/css/main.css",
        "https://example.com/images/hero.png",
        "https://example.com/docs/guide.pdf",
      ],
      "https://example.com/"
    );
    const links = await discoverSameOriginLinks(page, "https://example.com/");
    // Only /about should make it through — all static asset extensions filtered
    expect(links).toEqual(["https://example.com/about"]);
  });

  it("returns an empty array when there are no links at all", async () => {
    const page = mockPage([], "https://example.com/");
    const links = await discoverSameOriginLinks(page, "https://example.com/");
    expect(links).toEqual([]);
  });
});

describe("extractLinksFromHtml", () => {
  const origin = "https://example.com/";
  const currentPage = "https://example.com/";

  it("extracts same-origin links from static HTML", () => {
    const html = `<nav>
      <a href="/about">About</a>
      <a href="/work">Work</a>
      <a href="https://github.com/user">GitHub</a>
    </nav>`;
    const links = extractLinksFromHtml(html, currentPage, origin);
    expect(links.sort()).toEqual(
      ["https://example.com/about", "https://example.com/work"].sort()
    );
  });

  it("excludes cross-origin links", () => {
    const html = `<a href="https://other.com/page">External</a>
                  <a href="/internal">Internal</a>`;
    const links = extractLinksFromHtml(html, currentPage, origin);
    expect(links).toEqual(["https://example.com/internal"]);
  });

  it("excludes fragment-only links on the current page", () => {
    const html = `<a href="/about#section">Section</a>
                  <a href="#top">Top</a>`;
    const links = extractLinksFromHtml(html, currentPage, origin);
    // /about#section → normalizes to /about → different from current page → included
    // #top → resolves to https://example.com/#top → normalizes to https://example.com/ → excluded
    expect(links).toEqual(["https://example.com/about"]);
  });

  it("deduplicates links", () => {
    const html = `<a href="/work">Work</a><a href="/work/">Work again</a>`;
    const links = extractLinksFromHtml(html, currentPage, origin);
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("https://example.com/work");
  });

  it("returns empty array for HTML with no internal links", () => {
    const html = `<p>No links here</p>`;
    const links = extractLinksFromHtml(html, currentPage, origin);
    expect(links).toEqual([]);
  });

  it("handles relative paths correctly", () => {
    const html = `<a href="contact">Contact</a>`;
    const links = extractLinksFromHtml(html, currentPage, origin);
    expect(links).toEqual(["https://example.com/contact"]);
  });
});

