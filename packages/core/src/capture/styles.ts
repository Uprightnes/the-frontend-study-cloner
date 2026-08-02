import type { Page } from "playwright";
import type { ComputedStyleEntry } from "../types/index.js";

const STYLE_PROPERTIES = [
  "display",
  "position",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "padding",
  "margin",
  "width",
  "height",
  "maxWidth",
  "minHeight",
  "backgroundColor",
  "color",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "borderRadius",
  "border",
  "boxShadow",
  "opacity",
  "zIndex",
  "gridTemplateColumns",
  "overflow",
  "transform",
  "transition",
] as const;

/**
 * Extracts computed styles for elements that meaningfully affect layout
 * or appearance, skipping zero-size/invisible elements to keep the output
 * manageable. Tags each element with a `data-fsc-style-id` attribute so
 * Study mode's beautification/reconstruction step can correlate a style
 * entry back to its DOM node after the HTML has been serialized.
 */
export async function extractComputedStyles(page: Page): Promise<ComputedStyleEntry[]> {
  return await page.evaluate((properties) => {
    const entries: Array<{
      elementId: number;
      tag: string;
      classes: string;
      styles: Record<string, string>;
    }> = [];

    const elements = Array.from(document.querySelectorAll("*"));
    let nextId = 0;

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const computed = window.getComputedStyle(el);
      const styles: Record<string, string> = {};
      for (const prop of properties) {
        const value = (computed as any)[prop];
        if (value && value !== "none" && value !== "normal" && value !== "auto") {
          styles[prop] = value;
        }
      }

      if (Object.keys(styles).length > 0) {
        const id = nextId++;
        el.setAttribute("data-fsc-style-id", String(id));
        entries.push({
          elementId: id,
          tag: el.tagName.toLowerCase(),
          classes: typeof el.className === "string" ? el.className : "",
          styles,
        });
      }
    }

    return entries;
  }, STYLE_PROPERTIES as unknown as string[]);
}
