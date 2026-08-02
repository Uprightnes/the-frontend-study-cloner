// Public API surface for @fsc/core.
// CLI, future web UI, and third-party plugins should import only from
// here rather than reaching into individual stage modules directly, so
// internal refactors don't break consumers.

export * from "./types/index.js";

export { captureSite, crawlSite } from "./capture/orchestrator.js";
export { assembleRunMode } from "./assemble/orchestrator.js";
export { assembleStudyMode } from "./study/studyOrchestrator.js";

export { checkRobotsTxt } from "./ethics/robots.js";
export { assertConsent, createConsent, ETHICAL_USE_NOTICE, ConsentRequiredError } from "./ethics/consent.js";
export { generateVisualDiff, type VisualDiffOptions, type VisualDiffResult } from "./diff/visualDiff.js";
