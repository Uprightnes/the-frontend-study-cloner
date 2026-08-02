import type { EthicalConsent } from "../types/index.js";

export class ConsentRequiredError extends Error {
  constructor() {
    super(
      "Crawl refused: no ethical-use consent was provided. " +
        "Callers must obtain explicit, affirmative confirmation from the " +
        "user before invoking the crawler. See EthicalConsent in types/index.ts."
    );
    this.name = "ConsentRequiredError";
  }
}

export const ETHICAL_USE_NOTICE = `
This tool will capture a public website's frontend for personal learning,
study, and redesign practice only.

By proceeding you confirm that you will:
  - NOT redistribute, publish, or rehost the generated output
  - NOT use the generated output commercially
  - Respect the target site's Terms of Service
  - Understand the output is an approximation, not the original source

The tool will respect robots.txt and apply rate limiting by default.
`.trim();

/**
 * Validates that a well-formed, explicit consent object was provided.
 *
 * This function deliberately does not accept a boolean shorthand or a
 * default value — every caller (CLI, future web UI, programmatic SDK use)
 * must construct an EthicalConsent object themselves, which forces the
 * decision to be a conscious one at the call site rather than something
 * that can be silently defaulted to `true`.
 */
export function assertConsent(consent: EthicalConsent | undefined): EthicalConsent {
  if (!consent || consent.acknowledged !== true || !consent.acknowledgedAt) {
    throw new ConsentRequiredError();
  }
  return consent;
}

export function createConsent(): EthicalConsent {
  return {
    acknowledged: true,
    acknowledgedAt: new Date().toISOString(),
  };
}
