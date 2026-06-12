// Outer-driven screenshot of a region of the (cross-origin, sandboxed) iframe.
//
// The parent cannot read the iframe DOM or canvas-grab its pixels, so the only way to obtain
// a picture of the rendered region is the browser Screen Capture API: capture the current tab
// with getDisplayMedia, grab one frame, and crop it to the user's selection. getDisplayMedia
// requires a transient user activation, so `capture()` must be called directly from a click
// handler (it awaits getDisplayMedia first).

import type { TargetRect } from "./protocol";

// A rectangle in parent CSS pixels, viewport-relative (matches getBoundingClientRect /
// clientX-clientY), so it lines up with the tab-capture frame with no scroll terms.
export type SelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type CaptureAnchor = {
  seeId?: string;
  seeLabel?: string;
  contentRect?: TargetRect;
};

export type CaptureResult = {
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
  anchor?: CaptureAnchor;
  capturedAt: string;
  frameWidth: number;
  frameHeight: number;
};

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported" | "cancelled" | "wrong-surface" | "empty-selection" | "failed",
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

// Convert a marked element's rect (iframe-content CSS px, viewport-relative) into parent CSS px.
// `iframeRect` is the iframe element's live on-screen box (already includes the CSS scale
// transform); deriving the scale from it avoids drift from the rounded frame metrics.
export function contentRectToParentRect(contentRect: TargetRect, iframeRect: DOMRectReadOnly | DOMRect, frameWidth: number): SelectionRect {
  const scale = frameWidth > 0 ? iframeRect.width / frameWidth : 1;
  return {
    left: iframeRect.left + contentRect.x * scale,
    top: iframeRect.top + contentRect.y * scale,
    width: contentRect.width * scale,
    height: contentRect.height * scale,
  };
}

// Map a viewport-relative parent CSS-px rect to an integer crop rect in the captured frame's
// device pixels. `sx`/`sy` are measured from the frame vs the viewport, which folds in both
// devicePixelRatio and any browser zoom — more reliable than computing them.
export function mapRectToDevicePixels(
  selection: SelectionRect,
  frame: { width: number; height: number },
  viewport: { innerWidth: number; innerHeight: number },
): { x: number; y: number; width: number; height: number } {
  const sx = viewport.innerWidth > 0 ? frame.width / viewport.innerWidth : 1;
  const sy = viewport.innerHeight > 0 ? frame.height / viewport.innerHeight : 1;
  const left = clamp(Math.round(selection.left * sx), 0, frame.width);
  const top = clamp(Math.round(selection.top * sy), 0, frame.height);
  const width = clamp(Math.round(selection.width * sx), 0, frame.width - left);
  const height = clamp(Math.round(selection.height * sy), 0, frame.height - top);
  return { x: left, y: top, width, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function supportsDisplayCapture(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia);
}

// Owns the live MediaStream so repeated captures don't re-prompt. The viewer keeps one
// instance and stops it on inspect-disable / unmount / pagehide.
export class DisplayCapture {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private onEnded: (() => void) | null = null;

  constructor(onEnded?: () => void) {
    this.onEnded = onEnded ?? null;
  }

  isActive(): boolean {
    return this.track?.readyState === "live";
  }

  // Must be called from within a user gesture (getDisplayMedia is awaited first).
  async capture(selection: SelectionRect, anchor?: CaptureAnchor): Promise<CaptureResult> {
    if (selection.width < 1 || selection.height < 1) {
      throw new CaptureError("Select a region first.", "empty-selection");
    }
    if (!supportsDisplayCapture()) {
      throw new CaptureError("Screen capture is not supported in this browser.", "unsupported");
    }

    const track = await this.ensureTrack();
    const frame = await grabFrame(track, this.stream);
    const surface = track.getSettings().displaySurface;
    if (surface && surface !== "browser") {
      this.stop();
      throw new CaptureError("Please share “This Tab” to capture the region.", "wrong-surface");
    }

    const crop = mapRectToDevicePixels(selection, { width: frame.width, height: frame.height }, {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    });
    if (crop.width < 1 || crop.height < 1) {
      frame.close();
      throw new CaptureError("Selection is too small to capture.", "empty-selection");
    }

    const canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      frame.close();
      throw new CaptureError("Could not create a drawing context.", "failed");
    }
    ctx.drawImage(frame.image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    frame.close();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new CaptureError("Could not encode the capture.", "failed");
    }

    return {
      blob,
      dataUrl: canvas.toDataURL("image/png"),
      width: crop.width,
      height: crop.height,
      anchor,
      capturedAt: new Date().toISOString(),
      frameWidth: frame.width,
      frameHeight: frame.height,
    };
  }

  private async ensureTrack(): Promise<MediaStreamTrack> {
    if (this.track?.readyState === "live") {
      return this.track;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" } as MediaTrackConstraints,
        audio: false,
        // Chromium hint to preselect the current tab; ignored elsewhere.
        preferCurrentTab: true,
      } as DisplayMediaStreamOptions);
    } catch (error) {
      const name = (error as DOMException)?.name;
      if (name === "NotAllowedError" || name === "AbortError") {
        throw new CaptureError("Capture cancelled.", "cancelled");
      }
      throw new CaptureError("Could not start screen capture.", "failed");
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      throw new CaptureError("No video track from screen capture.", "failed");
    }
    track.addEventListener("ended", () => {
      this.cleanup();
      this.onEnded?.();
    });
    this.stream = stream;
    this.track = track;
    return track;
  }

  stop(): void {
    this.cleanup();
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.track = null;
  }
}

type GrabbedFrame = {
  image: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
};

async function grabFrame(track: MediaStreamTrack, stream: MediaStream | null): Promise<GrabbedFrame> {
  // Preferred path: ImageCapture.grabFrame (Chromium).
  const ImageCaptureCtor = (window as unknown as { ImageCapture?: new (track: MediaStreamTrack) => { grabFrame: () => Promise<ImageBitmap> } }).ImageCapture;
  if (ImageCaptureCtor) {
    try {
      const bitmap = await new ImageCaptureCtor(track).grabFrame();
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to the <video> path.
    }
  }

  // Fallback: render the stream into a hidden <video> and read one frame (Safari/Firefox).
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream ?? new MediaStream([track]);
  await video.play().catch(() => undefined);
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener("loadedmetadata", done, { once: true });
      window.setTimeout(done, 1000);
    });
  }
  return {
    image: video,
    width: video.videoWidth || window.innerWidth,
    height: video.videoHeight || window.innerHeight,
    close: () => {
      video.pause();
      video.srcObject = null;
    },
  };
}
