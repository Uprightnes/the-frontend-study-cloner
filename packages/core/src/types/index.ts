/**
 * Shared types for the capture → analyze → assemble pipeline.
 *
 * These types are the contract between pipeline stages. Keeping them in one
 * place makes it possible for the CLI, a future web UI, or third-party
 * plugins to depend on stable shapes without reaching into implementation
 * details of any single stage.
 */

export interface EthicalConsent {
  /** Must be explicitly true; there is no default-true shortcut. */
  acknowledged: true;
  /** ISO timestamp of when consent was given, for audit/logging purposes. */
  acknowledgedAt: string;
}

export interface CrawlOptions {
  /** The root URL to begin crawling from. */
  targetUrl: string;
  /** Maximum number of same-origin pages to visit. Default: 50. */
  maxPages?: number;
  /** Milliseconds to wait between requests to the same origin. Default: 2000. */
  crawlDelayMs?: number;
  /** Viewports to capture for responsive reconstruction. */
  viewports?: Viewport[];
  /**
   * If true, the crawler will click/hover/scroll to surface lazily-loaded
   * content and force dynamic chunks to load. Slower, more thorough.
   */
  thorough?: boolean;
  /**
   * Explicit, required confirmation that the user has reviewed and agreed
   * to the ethical usage terms for this crawl session. The pipeline will
   * refuse to run without this.
   */
  consent: EthicalConsent;

  onProgress?: ProgressCallback;
}

export type ProgressEventType =
  | "browser-launch"
  | "navigating"
  | "navigated"
  | "viewport-start"
  | "interactions-start"
  | "interactions-done"
  | "viewport-done"
  | "page-complete"
  | "crawl-complete";

export interface ProgressEvent {
  type: ProgressEventType;
  /** Human-readable detail, e.g. the URL being navigated to or viewport name. */
  message: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export const DEFAULT_VIEWPORTS: Viewport[] = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 834, height: 1194 },
  { name: "desktop", width: 1440, height: 900 },
];

export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs: number;
  /** Raw robots.txt body, retained for transparency/debugging. */
  rawText: string | null;
}

export type AssetType =
  | "document"
  | "script"
  | "stylesheet"
  | "image"
  | "font"
  | "media"
  | "other";

export interface CapturedAsset {
  url: string;
  type: AssetType;
  /** Populated once downloaded; absent if the request failed. */
  buffer?: Buffer;
  status: number;
  /** True if this URL was reachable only because of an interaction (click/hover/scroll). */
  discoveredViaInteraction: boolean;
}

export interface CapturedPage {
  url: string;
  viewport: Viewport;
  /** Fully rendered DOM HTML, after JS execution. */
  renderedHtml: string;
  /** Computed style snapshot for visually significant elements. */
  computedStyles: ComputedStyleEntry[];
}

export interface ComputedStyleEntry {
  elementId: number;
  tag: string;
  classes: string;
  styles: Record<string, string>;
}

export interface SourceMapFinding {
  bundleUrl: string;
  mapUrl: string;
  /** True if the .map file was actually fetchable, not just referenced. */
  confirmed: boolean;
}

export type DetectedFramework =
  | "react"
  | "next"
  | "vue"
  | "nuxt"
  | "angular"
  | "svelte"
  | "unknown";

export interface FrameworkDetectionResult {
  frameworks: DetectedFramework[];
  cssApproach: "tailwind" | "bootstrap" | "css-modules" | "css-in-js" | "plain-css" | "unknown";
}

export interface CaptureResult {
  targetUrl: string;
  capturedAt: string;
  pages: CapturedPage[];
  assets: CapturedAsset[];
  sourceMaps: SourceMapFinding[];
  framework: FrameworkDetectionResult;
  /** Domains other than the target's own origin that the captured code references. */
  externalDependencies: string[];
}

export interface AssembleOptions {
  outputDir: string;
}

export interface AssembleResult {
  outputDir: string;
  /** Relative paths of every file written, for reporting/testing. */
  filesWritten: string[];
  warnings: string[];
}

