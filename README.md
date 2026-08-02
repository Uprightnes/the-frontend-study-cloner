# fsc — Frontend Study Cloner

Capture any public website's real frontend into a working local copy.

```bash
npx fsc run https://example.com
```

That's it. No config. No build step.

---

## What it does

`fsc run` crawls a site with a real browser, captures every asset (CSS, JS, fonts, images), rewrites all references to work locally, and writes a static output you can open in any browser or deploy to any static host.

`fsc study` does the same, then additionally beautifies the code, infers component boundaries, and generates a site-specific README — so you can read through it like a GitHub repo and actually learn from it.

Both modes work on modern frameworks. Next.js App Router, React, Vue, Nuxt, Angular, Svelte — all handled correctly, including RSC flight data, image optimization API URLs, and framework-internal chunk loader paths.

---

## Install

```bash
npm install -g fsc
```

Playwright Chromium installs automatically. No extra steps.

Or use without installing:

```bash
npx fsc run https://example.com
```

---

## Usage

```bash
# Capture a working local copy
fsc run https://example.com --out ./mysite

# Capture + generate a readable study codebase
fsc study https://example.com --out ./mysite

# View the result
cd mysite-run && npx serve .
```

### Options

```
fsc run <url>    [options]
fsc study <url>  [options]

Options:
  -o, --out <dir>        Output folder name  (default: ./output)
  -m, --max-pages <n>    Max pages to crawl  (default: 50)
  --thorough             Simulate scroll/click/hover to surface lazy content
  --mobile-only          Capture mobile viewport only (faster)
  --yes-i-agree          Skip consent prompt (CI / your own sites only)
```

---

## Output

**Run mode** (`mysite-run/`):

```
_next/static/          # Framework assets at original paths
images/                # Downloaded images
index.html             # Rewritten, locally-serveable HTML
serve.json             # SPA fallback routing config
SERVING.md             # How to serve locally or deploy to Vercel/Netlify
.study-clone           # Provenance marker
```

**Study mode** (`mysite-study/`):

```
src/
  pages/               # Beautified HTML per page
  components/          # Heuristically inferred component sections
  styles/              # Beautified CSS
  utils/               # Beautified JS
README.md              # Site-specific analysis + accuracy table
package.json           # Provenance metadata
.study-clone           # Provenance marker
```

---

## Accuracy

| Site type | Visual fidelity |
|---|---|
| Static / marketing / portfolio | 88–95% |
| SaaS / business app | 78–88% |
| Full client-rendered SPA | 60–78% |
| GSAP-heavy / WebGL | 55–75% |

When source maps are publicly accessible, code readability in Study mode can exceed 90% for those bundles.

---

## Ethical use

This tool is for **personal learning, study, and redesign practice only.**

- Do not redistribute, rehost, or use output commercially
- Do not use against sites that prohibit scraping in their Terms of Service
- The tool respects `robots.txt` and enforces rate limiting by default
- Every run requires explicit consent — you must type "I agree" before any crawl begins

Every output folder contains a `.study-clone` provenance marker with the source URL, capture timestamp, and this tool's identity.

---

## How it compares

| | fsc | HTTrack | AI reconstruction tools |
|---|---|---|---|
| Works on Next.js / React SPAs | ✓ | ✗ | ✓ |
| Captures real CSS/JS (not reconstructed) | ✓ | ✓ | ✗ |
| Handles RSC, image optimization APIs | ✓ | ✗ | ✗ |
| Works offline after capture | ✓ | ✓ | ✗ |
| Output is editable modern code | ✗ | ✗ | ✓ |

---

## Contributing

```bash
git clone https://github.com/YOUR_USERNAME/frontend-study-cloner
cd frontend-study-cloner
npm install
cd packages/core && npx tsc --build . --force
cd ../cli && npx tsc --build . --force
node packages/cli/dist/cli.js run https://example.com
```

Tests: `cd packages/core && npx vitest run`

See [SETUP.md](./SETUP.md) for architecture overview and contribution guide.

---

## License

MIT
