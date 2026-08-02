import * as prettier from "prettier";

export interface BeautifyResult {
  output: string;
  /** False if formatting failed and the original input was returned unchanged. */
  succeeded: boolean;
}

/**
 * Beautifies HTML. Prettier's HTML parser is generally robust even
 * against slightly malformed markup (browsers themselves are forgiving,
 * and Prettier's parser tolerates a similar range), so failures here are
 * rare. We still catch defensively rather than letting one malformed
 * page abort an entire multi-page Study-mode run.
 */
export async function beautifyHtml(html: string): Promise<BeautifyResult> {
  try {
    const output = await prettier.format(html, {
      parser: "html",
      printWidth: 100,
      tabWidth: 2,
      htmlWhitespaceSensitivity: "ignore",
    });
    return { output, succeeded: true };
  } catch {
    return { output: html, succeeded: false };
  }
}

export async function beautifyCss(css: string): Promise<BeautifyResult> {
  try {
    const output = await prettier.format(css, {
      parser: "css",
      printWidth: 80,
      tabWidth: 2,
    });
    return { output, succeeded: true };
  } catch {
    return { output: css, succeeded: false };
  }
}

/**
 * Beautifies JS. This is the case most likely to fail or produce
 * low-value output, consistent with this project's own accuracy
 * analysis: Prettier fixes whitespace/indentation, not semantics, so a
 * minified bundle with single-letter variable names comes out as
 * readably-indented single-letter-variable-name code — still not
 * "readable" in any meaningful sense, just less visually compressed.
 *
 * We still run it (indentation alone helps a human scan a bundle's
 * rough shape), but the caller should not present this as equivalent to
 * genuine readability. The AI-assisted refactor pass (see aiRefactor.ts)
 * is what actually targets the renaming/comprehension problem, on
 * isolated, bounded code units rather than whole bundles.
 */
export async function beautifyJs(js: string): Promise<BeautifyResult> {
  try {
    const output = await prettier.format(js, {
      parser: "babel",
      printWidth: 100,
      tabWidth: 2,
      semi: true,
    });
    return { output, succeeded: true };
  } catch {
    // Extremely dense/unusual minified output (e.g. heavily obfuscated
    // bundles, some webpack runtime chunks) can occasionally defeat even
    // Babel's tolerant parser. Returning the original unmodified is the
    // correct fallback — we never want a failed beautification attempt
    // to corrupt a working bundle.
    return { output: js, succeeded: false };
  }
}
