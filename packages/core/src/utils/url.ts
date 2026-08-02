/**
 * Determines whether `candidateUrl` is on the same origin as `baseUrl`.
 *
 * Used to enforce the same-origin lock required by the PRD: the crawler
 * must not silently follow links off the target domain. Callers needing
 * cross-domain crawling must implement an explicit opt-in flow elsewhere;
 * this function intentionally provides no parameter to relax the check.
 *
 * Note on relative candidates: `candidateUrl` is resolved against
 * `baseUrl` before comparison (matching how a browser resolves an
 * href), so a bare relative path or even a string that merely looks
 * like a path segment will resolve to, and correctly report as,
 * same-origin. This function only returns false when the candidate is
 * genuinely unparseable or resolves to a different origin — it does not
 * attempt to validate that the candidate "looks like" a sensible URL.
 */
export function isSameOrigin(baseUrl: string, candidateUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const candidate = new URL(candidateUrl, baseUrl);
    return base.origin === candidate.origin;
  } catch {
    return false;
  }
}

/**
 * Normalizes a URL for use as a dedupe key: strips the fragment (per RFC,
 * and as called out in the HTTrack chapter this project draws on — the
 * fragment is never part of the resource identity for crawling purposes)
 * and removes a trailing slash for consistency.
 */
export function normalizeUrlForDedupe(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  let normalized = url.toString();
  if (normalized.endsWith("/") && url.pathname !== "/") {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
