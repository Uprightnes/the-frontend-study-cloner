import { describe, it, expect } from "vitest";
import { generatePackageJson } from "../src/study/packageJsonGenerator.js";
import type { CaptureResult } from "../src/types/index.js";

function baseCapture(targetUrl: string): CaptureResult {
  return {
    targetUrl,
    capturedAt: "2026-06-18T00:00:00.000Z",
    pages: [],
    assets: [],
    sourceMaps: [],
    framework: { frameworks: ["react", "next"], cssApproach: "tailwind" },
    externalDependencies: [],
  };
}

describe("generatePackageJson", () => {
  it("strips a www. prefix when slugifying the package name", () => {
    const json = JSON.parse(generatePackageJson({ capture: baseCapture("https://www.example.com/"), toolVersion: "0.1.0" }));
    expect(json.name).toBe("example-com-study-clone");
  });

  it("produces a valid npm package name with no www. prefix present", () => {
    const json = JSON.parse(generatePackageJson({ capture: baseCapture("https://example.com/"), toolVersion: "0.1.0" }));
    expect(json.name).toBe("example-com-study-clone");
  });

  it("records detected framework and CSS approach in the studyClone metadata block", () => {
    const json = JSON.parse(generatePackageJson({ capture: baseCapture("https://example.com/"), toolVersion: "0.1.0" }));
    expect(json.studyClone.detectedFramework).toEqual(["react", "next"]);
    expect(json.studyClone.detectedCssApproach).toBe("tailwind");
  });

  it("marks the package as private to discourage accidental publishing", () => {
    const json = JSON.parse(generatePackageJson({ capture: baseCapture("https://example.com/"), toolVersion: "0.1.0" }));
    expect(json.private).toBe(true);
  });

  it("includes the non-optional usage-purpose statement in metadata", () => {
    const json = JSON.parse(generatePackageJson({ capture: baseCapture("https://example.com/"), toolVersion: "0.1.0" }));
    expect(json.studyClone.purpose).toContain("Not for redistribution");
  });
});
