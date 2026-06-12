import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { InspectTarget, TargetRect } from "./protocol";

export type Selection = {
  rect: TargetRect;
  seeId?: string;
  seeLabel?: string;
};

type InspectOverlayProps = {
  active: boolean;
  targets: InspectTarget[];
  frameWidth: number;
  frameHeight: number;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
};

// Rendered as a sibling of the iframe INSIDE the scaled frame container, so it shares the
// iframe's CSS-px coordinate space (the SDK reports target rects in iframe-content CSS px,
// and the iframe fills the frame 1:1). That means target rects and the marquee are drawn
// directly in content px; the ancestor `transform: scale()` scales the overlay with the frame.
//
// Pointer events pass straight through to the iframe unless inspect mode is active, so normal
// browsing is never blocked.
export function InspectOverlay({ active, targets, frameWidth, frameHeight, selection, onSelect }: InspectOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [marquee, setMarquee] = useState<TargetRect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  // Convert a pointer event to content-px coordinates within the (scaled) overlay.
  function toContentPoint(event: React.PointerEvent): { x: number; y: number } {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      return { x: 0, y: 0 };
    }
    const scale = rect.width / frameWidth;
    const x = clamp((event.clientX - rect.left) / scale, 0, frameWidth);
    const y = clamp((event.clientY - rect.top) / scale, 0, frameHeight);
    return { x, y };
  }

  function handlePointerDown(event: React.PointerEvent) {
    if (!active || event.button !== 0) {
      return;
    }
    const point = toContentPoint(event);
    dragStart.current = point;
    setMarquee({ x: point.x, y: point.y, width: 0, height: 0 });
    overlayRef.current?.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent) {
    if (!dragStart.current) {
      return;
    }
    const point = toContentPoint(event);
    const start = dragStart.current;
    setMarquee({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  }

  function handlePointerUp(event: React.PointerEvent) {
    if (!dragStart.current) {
      return;
    }
    overlayRef.current?.releasePointerCapture(event.pointerId);
    dragStart.current = null;
    const current = marquee;
    setMarquee(null);
    if (current && current.width >= 4 && current.height >= 4) {
      onSelect({ rect: current });
    }
  }

  return (
    <div
      ref={overlayRef}
      className={cn("absolute inset-0 z-20", active ? "pointer-events-auto cursor-crosshair" : "pointer-events-none")}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      aria-hidden={!active}
    >
      {active ? <div className="absolute inset-0 bg-foreground/5" /> : null}

      {active
        ? targets.map((target) => {
            const isSelected = selection?.seeId != null && selection.seeId === target.seeId;
            return (
              <button
                key={target.seeId}
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSelect({ rect: target.rect, seeId: target.seeId, seeLabel: target.seeLabel })}
                className={cn(
                  "absolute m-0 border bg-primary/5 p-0 text-left transition-colors hover:bg-primary/15",
                  isSelected ? "border-primary ring-2 ring-primary" : "border-primary/50",
                )}
                style={pxBox(target.rect)}
              >
                {target.seeLabel ? (
                  <span className="pointer-events-none absolute left-0 top-0 max-w-full truncate rounded-br bg-primary px-1.5 py-0.5 font-mono text-[10px] leading-tight text-primary-foreground">
                    {target.seeLabel}
                  </span>
                ) : null}
              </button>
            );
          })
        : null}

      {marquee ? (
        <div className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10" style={pxBox(marquee)} />
      ) : null}

      {active && selection && selection.seeId == null ? (
        <div className="pointer-events-none absolute border-2 border-primary bg-primary/15 ring-2 ring-primary" style={pxBox(selection.rect)} />
      ) : null}
    </div>
  );
}

function pxBox(rect: TargetRect): React.CSSProperties {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
