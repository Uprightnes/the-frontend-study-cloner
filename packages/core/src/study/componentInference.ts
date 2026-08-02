import { parse, HTMLElement } from "node-html-parser";

export interface InferredComponent {
  /** Best-effort, human-readable name. Not guaranteed accurate — see module docstring. */
  name: string;
  /** The component's outer HTML, exactly as captured (not yet beautified). */
  html: string;
  /** Approximate nesting depth in the original document, for ordering output sensibly. */
  depth: number;
  /** A CSS selector describing where this was found, for debugging/traceability. */
  selector: string;
}

// These semantic tags are treated as self-contained leaf components: once
// found, we extract them whole and do not recurse into their children.
// This is appropriate for header/footer/nav/aside because they're
// typically small, cohesive units where the internal structure (e.g. a
// nav's individual links) isn't independently interesting to split out
// further.
const LEAF_SEMANTIC_TAG_NAMES: Record<string, string> = {
  header: "Header",
  footer: "Footer",
  nav: "Navbar",
  aside: "Sidebar",
};

// In contrast, <main> (and similarly generic full-width wrapper tags) is
// a structural landmark that typically wraps a page's ENTIRE primary
// content area — treating it as a leaf component would silently swallow
// every genuinely distinct section inside it (hero banners, card grids,
// testimonials, etc.) into one big undifferentiated blob. We recurse
// through these rather than stopping at them.
const PASSTHROUGH_SEMANTIC_TAGS = new Set(["main", "div", "section"]);

const CLASS_NAME_SIGNALS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\b(navbar|nav-bar|navigation)\b/i, name: "Navbar" },
  { pattern: /\b(hero|banner|jumbotron)\b/i, name: "Hero" },
  { pattern: /\b(footer|foot)\b/i, name: "Footer" },
  { pattern: /\b(sidebar|side-bar)\b/i, name: "Sidebar" },
  { pattern: /\b(modal|dialog|overlay)\b/i, name: "Modal" },
  { pattern: /\b(card|tile)\b/i, name: "Card" },
  { pattern: /\b(testimonial)\b/i, name: "Testimonial" },
  { pattern: /\b(gallery)\b/i, name: "Gallery" },
  { pattern: /\b(cta|call-to-action)\b/i, name: "CallToAction" },
];

/**
 * Component boundary inference is a heuristic, not a ground-truth
 * recovery of the original component structure. Per this project's own
 * accuracy analysis, component *boundaries* (where one logical section
 * ends and another begins) are detectable with reasonable reliability
 * via structural/semantic signals, but component *naming* is closer to
 * a plausible guess — there is no way to recover an original developer's
 * actual naming choice from rendered output alone. Output consuming this
 * should always be labeled as inferred (see studyOrchestrator.ts), never
 * presented as recovered original structure.
 */
export function inferComponents(renderedHtml: string): InferredComponent[] {
  const root = parse(renderedHtml);
  const body = root.querySelector("body") ?? root;
  const components: InferredComponent[] = [];
  const usedNames = new Map<string, number>();

  function walk(node: HTMLElement, depth: number): void {
    if (!node.tagName) return;

    const signal = detectComponentSignal(node);
    if (signal) {
      const name = uniqueName(signal, usedNames);
      components.push({
        name,
        html: node.outerHTML,
        depth,
        selector: buildDebugSelector(node),
      });
      return; // don't recurse into a recognized component's own children
    }

    for (const child of node.childNodes) {
      if (child instanceof HTMLElement) walk(child, depth + 1);
    }
  }

  walk(body as HTMLElement, 0);
  return components;
}

function detectComponentSignal(node: HTMLElement): string | null {
  const tagName = node.tagName?.toLowerCase();

  // Non-passthrough semantic tags (header, footer, nav, aside) are
  // self-contained leaf components — extract and stop recursing.
  if (tagName && !PASSTHROUGH_SEMANTIC_TAGS.has(tagName) && LEAF_SEMANTIC_TAG_NAMES[tagName]) {
    return LEAF_SEMANTIC_TAG_NAMES[tagName];
  }

  // Class-name signals apply to ALL elements regardless of tag, including
  // passthrough tags like div/main/section. A div with class="hero-banner"
  // is a Hero component. A main element doesn't get classified by tag
  // name alone, but its children's class names still fire normally.
  const classAttr = node.getAttribute("class") ?? "";
  for (const { pattern, name } of CLASS_NAME_SIGNALS) {
    if (pattern.test(classAttr)) return name;
  }

  // Structural repetition: only when children carry no signals themselves.
  const children = node.childNodes.filter((c): c is HTMLElement => c instanceof HTMLElement);
  if (children.length >= 3) {
    const firstTag = children[0]?.tagName;
    const allSameTag = firstTag && children.every((c) => c.tagName === firstTag);
    const anyChildHasOwnSignal = children.some((c) => detectComponentSignal(c) !== null);
    if (allSameTag && !anyChildHasOwnSignal) return "RepeatedList";
  }

  return null;
}

function uniqueName(baseName: string, usedNames: Map<string, number>): string {
  const count = usedNames.get(baseName) ?? 0;
  usedNames.set(baseName, count + 1);
  return count === 0 ? baseName : `${baseName}${count + 1}`;
}

function buildDebugSelector(node: HTMLElement): string {
  const tag = node.tagName?.toLowerCase() ?? "div";
  const classAttr = node.getAttribute("class");
  const firstClass = classAttr?.split(/\s+/).filter(Boolean)[0];
  return firstClass ? `${tag}.${firstClass}` : tag;
}
