import prompts from "prompts";
import pc from "picocolors";
import { ETHICAL_USE_NOTICE, createConsent, type EthicalConsent } from "fsc-core";

/**
 * Displays the ethical-use notice and requires the user to type an exact
 * confirmation phrase (not just press Enter) before a crawl proceeds.
 *
 * Per PRD section 9 ("Consent gate"), this must not be a default-
 * bypassable Y/n prompt where Enter accidentally confirms — requiring a
 * typed phrase ensures this is a deliberate action, not a habitual
 * keypress. Returns undefined (not an EthicalConsent) if the user
 * declines or types anything other than the exact phrase, which the
 * caller must treat as "do not proceed."
 */
export async function promptForConsent(targetUrl: string): Promise<EthicalConsent | undefined> {
  console.log("");
  console.log(pc.bold(pc.yellow("⚠ Ethical Use Agreement")));
  console.log(pc.dim(`Target: ${targetUrl}`));
  console.log("");
  console.log(ETHICAL_USE_NOTICE);
  console.log("");

  const response = await prompts({
    type: "text",
    name: "confirmation",
    message: `Type ${pc.bold('"I agree"')} to proceed, or anything else to cancel:`,
  });

  if (response.confirmation?.trim().toLowerCase() !== "i agree") {
    return undefined;
  }

  return createConsent();
}
