# Contributor Setup

This is the dev setup guide. If you just want to use fsc, see the [README](./README.md).

## Requirements

- Node.js 18.18+
- npm 9+

## Install

```bash
git clone https://github.com/YOUR_USERNAME/frontend-study-cloner
cd frontend-study-cloner
npm install
npx playwright install chromium   # one-time browser download
```

## Build

```bash
# Build everything
npm run build

# Or build packages individually
cd packages/core && npx tsc --build . --force
cd packages/cli  && npx tsc --build . --force
```

## Test

```bash
npm test
# or
cd packages/core && npx vitest run
cd packages/core && npx vitest          # watch mode
```

## Run locally

```bash
node packages/cli/dist/cli.js run https://example.com --out ./test-output
node packages/cli/dist/cli.js study https://example.com --out ./test-output
```

## Architecture

```
packages/
  core/   (fsc-core)   — capture, analyze, assemble engine
  cli/    (fsc)        — CLI tool, consent prompt, pipeline orchestration
```

### Core pipeline

```
consent gate
  → robots.txt check
  → Playwright crawl (multi-page, multi-viewport)
      → network interception (captures every asset response)
      → GSAP/ScrollTrigger scroll-frame capture
      → WebGL/Three.js canvas snapshotting
      → dynamic import forcing
  → framework detection (Next.js, React, Vue, Nuxt, Angular, Svelte)
  → source map detection
  → path mapping (preserveStructure: true for Run mode)
  → RSC flight data scanning + missing asset fetch
  → Next.js image optimization URL decoding
  → HTML/CSS reference rewriting
  → Run mode output
  → (optional) beautify + component inference + README → Study mode output
```

### Key files

| File | Purpose |
|---|---|
| `packages/core/src/capture/orchestrator.ts` | Playwright crawl orchestration |
| `packages/core/src/assemble/pathMapper.ts` | URL → local path mapping |
| `packages/core/src/assemble/writeRunMode.ts` | Run mode assembly |
| `packages/core/src/assemble/nextImageDecoder.ts` | Next.js image optimization handling |
| `packages/core/src/assemble/rscAssetScanner.ts` | RSC flight data asset scanning |
| `packages/core/src/assemble/rewriteReferences.ts` | HTML/CSS/JS reference rewriting |
| `packages/core/src/study/studyOrchestrator.ts` | Study mode assembly |
| `packages/cli/src/cli.ts` | CLI entry point |
| `packages/cli/src/pipeline.ts` | Shared run/study pipeline |

## Publishing

```bash
# Publish core first (cli depends on it)
cd packages/core && npm publish --access public
cd packages/cli  && npm publish --access public
```

The `postinstall` script in `fsc` (the CLI package) runs automatically after
`npm install fsc` and downloads Playwright Chromium. It skips silently when
`dist/` doesn't exist (local dev) or when `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
