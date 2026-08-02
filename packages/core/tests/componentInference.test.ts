import { describe, it, expect } from "vitest";
import { inferComponents } from "../src/study/componentInference.js";

describe("inferComponents", () => {
  it("detects semantic header, nav, and footer; treats main as a structural passthrough", () => {
    const html = `
      <body>
        <header><div>Logo</div></header>
        <nav><a href="/">Home</a></nav>
        <main><p>Content</p></main>
        <footer><p>Copyright</p></footer>
      </body>
    `;
    const components = inferComponents(html);
    const names = components.map((c) => c.name);
    expect(names).toContain("Header");
    expect(names).toContain("Navbar");
    expect(names).toContain("Footer");
    // <main> is intentionally a passthrough: it wraps the page's entire
    // content area and classifying it as one component would swallow every
    // interesting section inside it. Its children are walked instead.
    // In this test, <main> contains only a bare <p> with no signal, so
    // nothing is extracted from inside it — that is correct behavior.
    expect(names).not.toContain("MainContent");
  });

  it("detects a hero section via class name even with a generic div tag", () => {
    const html = `<body><div class="hero-banner"><h1>Welcome</h1></div></body>`;
    const components = inferComponents(html);
    expect(components.map((c) => c.name)).toContain("Hero");
  });

  it("detects a repeated card grid with no helpful class name at all", () => {
    const html = `
      <body>
        <div class="grid-xyz123">
          <article>Card 1</article>
          <article>Card 2</article>
          <article>Card 3</article>
          <article>Card 4</article>
        </div>
      </body>
    `;
    const components = inferComponents(html);
    expect(components.map((c) => c.name)).toContain("RepeatedList");
  });

  it("does not flag two unrelated sibling divs as a repeated list", () => {
    const html = `
      <body>
        <div class="container">
          <section>One</section>
          <aside>Two</aside>
        </div>
      </body>
    `;
    const components = inferComponents(html);
    // Two children, different tags — should not trigger RepeatedList,
    // and "aside" itself IS a semantic signal (Sidebar), so we expect
    // exactly that one component, not a false-positive RepeatedList.
    expect(components.map((c) => c.name)).not.toContain("RepeatedList");
  });

  it("assigns unique names when multiple instances of the same signal are found", () => {
    const html = `
      <body>
        <div class="card-a">A</div>
        <div class="card-b">B</div>
        <div class="testimonial-1">T1</div>
        <div class="testimonial-2">T2</div>
      </body>
    `;
    const components = inferComponents(html);
    const names = components.map((c) => c.name);
    // Both "card" divs match the same Card signal — second occurrence
    // should be disambiguated, not silently collide.
    expect(names.filter((n) => n.startsWith("Card")).length).toBe(2);
    expect(new Set(names).size).toBe(names.length); // all unique
  });

  it("does not recurse into the children of an already-recognized component", () => {
    const html = `
      <body>
        <header>
          <nav><a href="/">Home</a></nav>
        </header>
      </body>
    `;
    const components = inferComponents(html);
    // The <nav> is nested inside <header>; once header is recognized as
    // a component, we should not also separately extract its inner nav
    // as a second, overlapping component.
    expect(components.length).toBe(1);
    expect(components[0]?.name).toBe("Header");
  });

  it("returns an empty array for a page with no recognizable structure", () => {
    const html = `<body><span>just some text</span></body>`;
    expect(inferComponents(html)).toEqual([]);
  });
});
