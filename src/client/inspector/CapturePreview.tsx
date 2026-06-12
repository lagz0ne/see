import { useState } from "react";
import { CopyIcon, DownloadIcon, RefreshCcwIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CaptureResult } from "./captureSelection";

type CapturePreviewProps = {
  result: CaptureResult;
  onRetake: () => void;
  onClose: () => void;
};

// Floating panel that shows the cropped screenshot with copy / download / retake actions.
// Pinned below the header so it never covers the inspector bar.
export function CapturePreview({ result, onRetake, onClose }: CapturePreviewProps) {
  const [note, setNote] = useState("");

  async function copyImage() {
    try {
      const clipboardItem = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (navigator.clipboard?.write && clipboardItem) {
        await navigator.clipboard.write([new clipboardItem({ "image/png": result.blob })]);
        setNote("Copied to clipboard.");
        return;
      }
      setNote("Clipboard images are not supported here — use Download.");
    } catch {
      setNote("Could not copy — use Download.");
    }
  }

  function downloadImage() {
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `see-capture-${result.anchor?.seeId ?? "region"}.png`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setNote("Downloaded.");
  }

  return (
    <div className="absolute right-3 top-3 z-50 w-[min(calc(100vw-1.5rem),22rem)] rounded-xl border bg-card/95 p-3 shadow-2xl shadow-foreground/15 backdrop-blur">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">Capture</span>
          {result.anchor?.seeLabel ? (
            <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
              {result.anchor.seeLabel}
            </Badge>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close capture" onClick={onClose}>
          <XIcon data-icon="inline-start" />
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-[repeating-conic-gradient(theme(colors.muted.DEFAULT)_0%_25%,transparent_0%_50%)] [background-size:16px_16px]">
        <img src={result.dataUrl} alt="Captured region" className="mx-auto block max-h-64 w-auto object-contain" />
      </div>

      <p className="mt-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
        {result.width} × {result.height} px
      </p>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={copyImage}>
          <CopyIcon data-icon="inline-start" />
          Copy
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={downloadImage}>
          <DownloadIcon data-icon="inline-start" />
          Save
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onRetake}>
          <RefreshCcwIcon data-icon="inline-start" />
          Retake
        </Button>
      </div>

      {note ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
