import type { CapturedAsset } from "../types/index.js";

export interface CredentialWarning {
  bundleUrl: string;
  /** Human-readable description, not the actual key value (never log/store the real secret). */
  description: string;
  service: string;
}

/**
 * Looks for recognizable patterns of domain-locked third-party
 * credentials inside captured JS. This is necessarily a known-patterns
 * list (Google Maps, Firebase, reCAPTCHA, etc.) rather than a general
 * "find secrets" scanner — generic secret-scanning is a different,
 * harder problem (and a well-covered one by existing dedicated tools);
 * this function's narrower job is just to warn the user *why* a specific
 * widget likely won't work locally, per the PRD's requirement to flag
 * domain-locked credentials in Run mode output.
 *
 * Deliberately does NOT capture or store the actual key/token value in
 * the warning — only that a credential of a given type was found and
 * where — since there's no reason for the generated output to ever
 * persist someone's live API key in a README or log file.
 */
export function detectDomainLockedCredentials(assets: CapturedAsset[]): CredentialWarning[] {
  const warnings: CredentialWarning[] = [];

  const patterns: Array<{ service: string; regex: RegExp; description: string }> = [
    {
      service: "Google Maps",
      regex: /maps\.googleapis\.com\/maps\/api[^"'\s]*key=/,
      description:
        "Google Maps API key detected. Maps keys are typically restricted to approved domains/referrers and will likely fail with an authorization error when served from a different host.",
    },
    {
      service: "Firebase",
      regex: /apiKey["']?\s*:\s*["'][A-Za-z0-9_-]{20,}["']/,
      description:
        "Firebase config detected. Firebase API keys are often restricted by authorized domain list in the Firebase console; some features may reject requests from an unrecognized origin.",
    },
    {
      service: "reCAPTCHA",
      regex: /grecaptcha|recaptcha\/api\.js/,
      description:
        "reCAPTCHA detected. Site keys are registered against specific domains; the widget will likely fail to verify (or refuse to render) on a different host.",
    },
    {
      service: "Stripe (publishable key)",
      regex: /pk_(live|test)_[A-Za-z0-9]{20,}/,
      description:
        "Stripe publishable key detected. Not domain-locked by default, but any connected checkout/payment flow depends on a live backend that this local copy does not have.",
    },
  ];

  for (const asset of assets) {
    if (!asset.buffer || asset.type !== "script") continue;
    const text = asset.buffer.toString("utf-8");

    for (const { service, regex, description } of patterns) {
      if (regex.test(text)) {
        warnings.push({ bundleUrl: asset.url, service, description });
      }
    }
  }

  return warnings;
}
