import { describe, it, expect, vi } from "vitest";
import { CaptureSession } from "../src/capture/session.js";
import type { Page } from "playwright";

/**
 * Builds a minimal fake matching only the Page methods `navigate()` calls,
 * cast to `Page` for the test. We don't want to spin up a real browser in
 * unit tests — this isolates the fallback *logic* in session.ts, which is
 * what actually needs coverage (Playwright itself is trusted to fire
 * "load" and to throw TimeoutError correctly).
 */
function fakePage(overrides: Partial<Page> = {}): Page {
  return {
    goto: vi.fn(),
    isClosed: vi.fn().mockReturnValue(false),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Page;
}

function timeoutError(message = "Timeout 30000ms exceeded."): Error {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

describe("CaptureSession.navigate", () => {
  it("resolves normally when goto succeeds (networkidle reached)", async () => {
    const session = new CaptureSession();
    const page = fakePage({ goto: vi.fn().mockResolvedValue(null) });

    await expect(session.navigate(page, "https://example.com")).resolves.toBeUndefined();
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it("falls back to waitForLoadState('load') when networkidle times out, instead of throwing", async () => {
    const session = new CaptureSession();
    const page = fakePage({ goto: vi.fn().mockRejectedValue(timeoutError()) });

    // Sites with persistent background connections (websockets, polling
    // analytics) may never satisfy "networkidle" — this must not fail the
    // whole page capture.
    await expect(session.navigate(page, "https://example.com")).resolves.toBeUndefined();
    expect(page.waitForLoadState).toHaveBeenCalledWith("load", { timeout: 5_000 });
  });

  it("still resolves even if the load-state fallback itself times out", async () => {
    const session = new CaptureSession();
    const page = fakePage({
      goto: vi.fn().mockRejectedValue(timeoutError()),
      waitForLoadState: vi.fn().mockRejectedValue(timeoutError("load state timeout")),
    });

    // We accept whatever rendered rather than losing the page entirely.
    await expect(session.navigate(page, "https://example.com")).resolves.toBeUndefined();
  });

  it("re-throws non-timeout errors from goto without falling back", async () => {
    const session = new CaptureSession();
    const networkError = new Error("net::ERR_NAME_NOT_RESOLVED");
    const page = fakePage({ goto: vi.fn().mockRejectedValue(networkError) });

    await expect(session.navigate(page, "https://bad.invalid")).rejects.toThrow(
      "net::ERR_NAME_NOT_RESOLVED"
    );
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it("re-throws the timeout error if the page was already closed", async () => {
    const session = new CaptureSession();
    const page = fakePage({
      goto: vi.fn().mockRejectedValue(timeoutError()),
      isClosed: vi.fn().mockReturnValue(true),
    });

    await expect(session.navigate(page, "https://example.com")).rejects.toThrow("Timeout");
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });
});
