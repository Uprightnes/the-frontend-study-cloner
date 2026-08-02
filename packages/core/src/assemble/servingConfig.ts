import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptureResult } from "../types/index.js";
import { buildPathMappings } from "./pathMapper.js";

/**
 * Returns both the clean path and trailing-slash variant for a sub-page URL.
 *
 * `npx serve -s` uses exact source matching — "/salaries" does NOT match
 * "/salaries/" (with trailing slash). We generate both so direct navigation,
 * browser refresh, and link-click all serve the correct page regardless of
 * whether the browser normalises the URL with or without a trailing slash.
 *
 * The root path "/" is excluded — it is served by index.html automatically.
 */
function getRewriteVariants(
  urlPathname: string,
  localFile: string
): Array<{ urlPath: string; localFile: string }> {
  if (urlPathname === "/" || urlPathname === "") return [];
  const clean = urlPathname.replace(/\/$/, "");
  return [
    { urlPath: clean,        localFile },
    { urlPath: clean + "/",  localFile },
  ];
}

/**
 * Generates serving configuration files that make the Run-mode output work
 * correctly across multiple local and cloud static hosts.
 *
 * Four files are written:
 *
 * serve.json    — for `npx serve .` (recommended local serving method)
 * _redirects    — for Netlify
 * vercel.json   — for Vercel
 * SERVING.md    — human-readable instructions
 *
 * Each sub-page gets TWO rewrite entries: one without trailing slash and one
 * with. This covers both how browsers request URLs when navigating via links
 * (no trailing slash) and when typing directly or refreshing (trailing slash
 * added by the browser or a redirect).
 *
 * IMPORTANT — no catch-all in serve.json:
 * `serve-handler` (the engine behind `npx serve`) applies rewrites
 * *recursively*: after a rule matches and rewrites the path, it re-runs the
 * REMAINING rules against the newly-rewritten path. A catch-all rule
 * (`"**" -> "/index.html"`, or the one `-s`/`--single` injects internally)
 * still matches on that second pass — because "**" matches literally
 * anything, including the already-correct destination — and silently
 * rewrites every specific page back to "/index.html". This makes every
 * captured sub-page unreachable, with no error: the homepage renders at
 * every URL. Confirmed by reproducing against serve-handler's own
 * `applyRewrites`/`sourceMatches` logic and by testing an actual captured
 * multi-page site — removing the catch-all fixed every specific-page
 * rewrite; keeping it (with or without `-s`) broke all of them.
 *
 * Since fsc captures a fully-enumerated static site (every real page already
 * has its own specific rewrite above), there is no dynamic client-side route
 * that a catch-all would need to cover — an unmatched path simply isn't one
 * of the pages this tool captured, and a normal 404 from `serve` is the
 * correct, honest response. Netlify's `_redirects` and Vercel's
 * `vercel.json` use non-recursive, single-pass, first-match routing, so they
 * do NOT share this bug and keep their catch-all fallback for parity with
 * typical SPA deploys on those platforms.
 */
export async function writeServingConfig(
  outputDir: string,
  capture?: CaptureResult
): Promise<string[]> {

  const pageRewrites: Array<{ urlPath: string; localFile: string }> = [];

  if (capture) {
    const distinctPageUrls = new Set(capture.pages.map((p) => p.url));
    const stubs = Array.from(distinctPageUrls).map((url) => ({
      url,
      type: "document" as const,
      status: 200,
      discoveredViaInteraction: false,
    }));
    const mappings = buildPathMappings(stubs, { preserveStructure: true });

    for (const url of distinctPageUrls) {
      const mapping = mappings.get(url);
      if (!mapping) continue;
      const urlPath = new URL(url).pathname;
      pageRewrites.push(...getRewriteVariants(urlPath, mapping.localPath));
    }
  }

  const pageCount = (pageRewrites.length / 2) + 1; // each page = 2 entries; +1 for homepage

  // ── serve.json ───────────────────────────────────────────────────────────
  // No catch-all here — see the note above. Only the specific per-page
  // rewrites; index.html at "/" is already served by serve's own default
  // static-file resolution without needing a rewrite rule.
  const serveJson = {
    rewrites: pageRewrites.map(({ urlPath, localFile }) => ({
      source: urlPath,
      destination: `/${localFile}`,
    })),
  };
  await writeFile(
    path.join(outputDir, "serve.json"),
    JSON.stringify(serveJson, null, 2),
    "utf-8"
  );

  // ── _redirects (Netlify) ─────────────────────────────────────────────────
  const netlifyLines = [
    ...pageRewrites.map(({ urlPath, localFile }) => `${urlPath}  /${localFile}  200`),
    "/*  /index.html  200",
  ];
  await writeFile(
    path.join(outputDir, "_redirects"),
    netlifyLines.join("\n") + "\n",
    "utf-8"
  );

  // ── vercel.json (Vercel) ─────────────────────────────────────────────────
  const vercelJson = {
    rewrites: [
      ...pageRewrites.map(({ urlPath, localFile }) => ({
        source: urlPath,
        destination: `/${localFile}`,
      })),
      { source: "/(.*)", destination: "/index.html" },
    ],
  };
  await writeFile(
    path.join(outputDir, "vercel.json"),
    JSON.stringify(vercelJson, null, 2),
    "utf-8"
  );

  // ── SERVING.md ───────────────────────────────────────────────────────────
  const servingMd = `# Serving This Output

This is a captured, dist-style snapshot of ${capture?.targetUrl ?? "the site"}.
It contains ${pageCount} page(s) and requires a static server with URL rewriting.

## Quickest option

\`\`\`bash
npx serve .
\`\`\`

**Do not add \`-s\`/\`--single\`.** This output is a fully-enumerated static
multi-page site, not a client-routed SPA — every real page already has its
own rewrite in \`serve.json\`. The \`-s\` flag injects a catch-all fallback
that (due to a recursive-rewrite quirk in \`serve\`'s underlying engine)
silently breaks every specific-page rewrite and serves the homepage at every
URL instead. Plain \`npx serve .\` serves each page's clean URL correctly and
returns a normal 404 for anything that wasn't actually captured.

## Deploying to Netlify

Drop this folder into Netlify. The included \`_redirects\` file handles routing automatically.

## Deploying to Vercel

Run \`vercel --prod\` from this directory. The included \`vercel.json\` handles routing.

## Deploying elsewhere (nginx)

\`\`\`nginx
location / {
  try_files $uri $uri.html $uri/ =404;
}
\`\`\`

## What still won't work

Anything that depends on the original live backend (API calls, authentication,
search, personalised content) will not function — this is a frontend-only snapshot.
`;

  await writeFile(path.join(outputDir, "SERVING.md"), servingMd, "utf-8");

  return ["serve.json", "_redirects", "vercel.json", "SERVING.md"];
}

