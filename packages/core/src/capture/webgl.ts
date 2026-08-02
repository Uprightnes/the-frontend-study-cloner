import type { Page } from "playwright";

export interface CanvasSnapshot {
  selector: string;
  /** Data URL (PNG) of the canvas content at capture time. */
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Snapshots every <canvas> element on the page via toDataURL(). This is
 * the reliable, always-works path for WebGL/Three.js content: it captures
 * exactly what was rendered, with zero ambiguity, because it's reading
 * the actual pixel buffer rather than trying to infer what produced it.
 *
 * Limitation worth keeping explicit in generated output: this is a still
 * image. Animation, interactivity, and camera movement are not recovered
 * by this function — see captureCanvasOverTime for a basic motion
 * reference, and extractThreeSceneGraph for the best-effort structural
 * extraction (scene reconstruction is the stretch goal, not this).
 *
 * Note: canvases rendered with `preserveDrawingBuffer: false` (the
 * Three.js/WebGL default, for performance) may return a blank image if
 * snapshotted at the wrong moment relative to the render loop. Capturing
 * immediately after a requestAnimationFrame tends to work; if you get
 * blank snapshots, that's almost certainly the cause, not a bug in this
 * function.
 */
export async function snapshotCanvases(page: Page): Promise<CanvasSnapshot[]> {
  return await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    return canvases.map((canvas, index) => {
      let dataUrl = "";
      try {
        dataUrl = canvas.toDataURL("image/png");
      } catch {
        // Likely a tainted canvas (cross-origin texture without CORS
        // headers) — toDataURL throws a SecurityError in that case.
        // There is no workaround for this from outside the page's own
        // rendering pipeline.
        dataUrl = "";
      }
      const selector = canvas.id
        ? `#${canvas.id}`
        : `canvas:nth-of-type(${index + 1})`;
      return { selector, dataUrl, width: canvas.width, height: canvas.height };
    });
  });
}

/**
 * Captures a short sequence of canvas snapshots a fixed interval apart,
 * giving a basic motion reference (e.g., a rotating 3D model, a particle
 * system) without attempting full video capture. Useful as a visual aid
 * in the generated README ("here's roughly what this looked like
 * animating") even when full reconstruction isn't feasible.
 */
export async function captureCanvasOverTime(
  page: Page,
  durationMs = 3000,
  frameCount = 6
): Promise<CanvasSnapshot[][]> {
  const frames: CanvasSnapshot[][] = [];
  const intervalMs = durationMs / frameCount;
  for (let i = 0; i < frameCount; i++) {
    frames.push(await snapshotCanvases(page));
    await page.waitForTimeout(intervalMs);
  }
  return frames;
}

export interface ThreeSceneSummary {
  /** True only if window.__THREE_DEVTOOLS__ or a global scene reference was found. */
  introspectable: boolean;
  rendererInfo?: {
    type: string;
  };
  /** Best-effort object counts; entirely dependent on what's globally reachable. */
  objectCounts?: {
    meshes: number;
    lights: number;
    cameras: number;
  };
  notes: string[];
}

/**
 * Best-effort attempt to introspect a live Three.js scene graph.
 *
 * Important and expected limitation, consistent with what we discussed
 * about WebGL reconstruction generally: production builds essentially
 * never expose `scene`, `camera`, or `renderer` as accessible globals,
 * because there is no reason for a shipped bundle to do so. This function
 * checks a small set of common patterns (some sites attach these to
 * `window` for debugging during development and forget to remove it, or
 * a "Three.js Inspector"-style devtool extension may have patched
 * `THREE.Scene` to register instances). When none of these are present —
 * which, on a real production deployment, is the expected outcome — this
 * returns `introspectable: false` rather than guessing.
 *
 * This is intentionally not a video-to-geometry reconstruction attempt.
 * That is a fundamentally different (and far less reliable) class of
 * technique — closer to photogrammetry than to code extraction — and is
 * out of scope here. The canvas snapshot functions above are the
 * dependable fallback for visual reference.
 */
export async function extractThreeSceneGraph(page: Page): Promise<ThreeSceneSummary> {
  return await page.evaluate(() => {
    const w = window as any;
    const notes: string[] = [];

    // Common debug-leftover patterns, checked defensively.
    const candidateGlobals = ["scene", "__scene", "threeScene", "__THREE_DEVTOOLS__"];
    let foundScene: any = null;
    for (const key of candidateGlobals) {
      if (w[key]) {
        foundScene = w[key];
        notes.push(`Found candidate global: window.${key}`);
        break;
      }
    }

    if (!foundScene || !foundScene.children) {
      notes.push(
        "No accessible Three.js scene graph found. This is expected for " +
          "production builds, which have no reason to expose internal " +
          "renderer state globally. Falling back to canvas pixel snapshot only."
      );
      return { introspectable: false, notes };
    }

    let meshes = 0;
    let lights = 0;
    let cameras = 0;
    const walk = (obj: any) => {
      const type = obj?.type ?? "";
      if (type === "Mesh") meshes++;
      else if (type.includes("Light")) lights++;
      else if (type.includes("Camera")) cameras++;
      (obj.children ?? []).forEach(walk);
    };
    walk(foundScene);

    return {
      introspectable: true,
      objectCounts: { meshes, lights, cameras },
      notes,
    };
  });
}
