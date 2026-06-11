import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LinkIcon,
  MoonIcon,
  RefreshCcwIcon,
  RotateCwIcon,
  Settings2Icon,
  SunIcon,
  Trash2Icon,
  UploadCloudIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type StaticShareAppProps = {
  root: HTMLElement;
};

type UploadPayload = {
  id: string;
  viewerUrl: string;
  contentUrl: string;
  kind: "html" | "zip" | "resources";
  editToken: string;
  revision: number;
  resources: ResourceInfo[];
  createdAt: string;
  expiresAt: string;
};

type ResourceInfo = {
  path: string;
  bytes: number;
  sha256: string;
  updatedAt: string;
  contentType: string;
};

type ResourcePayload = {
  id: string;
  revision: number;
  contentRoot: string;
  contentUrl: string;
  resources: ResourceInfo[];
  extractedBytes: number;
  fileCount: number;
};

type StatusState = {
  message: string;
  tone: "neutral" | "success" | "error";
};

const TOKEN_STORAGE_KEY = "static-share-upload-token";
const VIEWER_CHROME_STORAGE_KEY = "static-share-viewer-chrome-visible";

export function StaticShareApp({ root }: StaticShareAppProps) {
  return (
    <TooltipProvider>
      {root.dataset.page === "viewer" ? <ViewerApp root={root} /> : <UploadApp root={root} />}
    </TooltipProvider>
  );
}

function UploadApp({ root }: StaticShareAppProps) {
  const maxUploadBytes = Number(root.dataset.maxUploadBytes || 0);
  const tokenRequired = root.dataset.tokenRequired === "true";
  const retentionDays = root.dataset.retentionDays || "7";
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [uploadToken, setUploadToken] = useState(() => (tokenRequired ? readSavedToken() : ""));
  const [editToken, setEditToken] = useState("");
  const [status, setStatus] = useState<StatusState>({
    message: "",
    tone: "neutral",
  });
  const [progress, setProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [result, setResult] = useState<UploadPayload | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (isUploading) {
      return;
    }
    const dropped = Array.from(event.dataTransfer.files ?? []);
    if (dropped.length > 0) {
      setFiles(dropped);
      setStatus({ message: "", tone: "neutral" });
    }
  }

  useEffect(() => {
    if (!tokenRequired) {
      forgetToken();
    }
  }, [tokenRequired]);

  const selectedFileMeta = useMemo(() => {
    if (files.length === 0) {
      return null;
    }
    const total = files.reduce((sum, item) => sum + item.size, 0);
    return files.length === 1 ? `${files[0].name} - ${formatBytes(total)}` : `${files.length} files - ${formatBytes(total)}`;
  }, [files]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(null);
    setProgress(0);

    if (files.length === 0) {
      setStatus({ message: "Choose at least one file first.", tone: "error" });
      fileInputRef.current?.focus();
      return;
    }

    const totalUploadBytes = files.reduce((sum, item) => sum + item.size, 0);
    if (maxUploadBytes && totalUploadBytes > maxUploadBytes) {
      setStatus({
        message: `Upload is too large. Limit: ${formatBytes(maxUploadBytes)}.`,
        tone: "error",
      });
      return;
    }

    if (tokenRequired && !uploadToken.trim()) {
      setStatus({ message: "Upload access token is required before sending the files.", tone: "error" });
      return;
    }

    const headers = uploadHeaders(uploadToken.trim());
    const formData = new FormData();
    files.forEach((item) => formData.append("file", item));
    if (title.trim()) {
      formData.set("title", title.trim());
    }
    if (editToken.trim()) {
      formData.set("editToken", editToken.trim());
    }

    try {
      setIsUploading(true);
      if (tokenRequired) {
        setStatus({ message: "Checking token...", tone: "neutral" });
        await checkToken(headers);
      }

      setStatus({ message: "Uploading 0%.", tone: "neutral" });
      const payload = await uploadFormData(formData, headers, (percent, loaded, total) => {
        setProgress(percent);
        setStatus({
          message: `Uploading ${percent}% (${formatBytes(loaded)} of ${formatBytes(total)}).`,
          tone: "neutral",
        });
      });

      setResult(payload);
      setEditToken(payload.editToken);
      setProgress(100);
      setStatus({ message: `Ready until ${formatDateTime(payload.expiresAt)}.`, tone: "success" });
    } catch (error) {
      setProgress(0);
      setStatus({
        message: error instanceof Error ? error.message : "Upload failed.",
        tone: "error",
      });
    } finally {
      setIsUploading(false);
    }
  }

  async function copyViewerLink() {
    if (!result?.viewerUrl) {
      return;
    }
    await copyText(result.viewerUrl);
    setStatus({ message: "Viewer link copied.", tone: "success" });
  }

  return (
    <main className="app-shell-bg min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-6xl items-center">
        <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(460px,0.9fr)] lg:items-center">
          <section className="flex flex-col gap-6">
            <div className="flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <FileArchiveIcon data-icon="inline-start" />
              </div>
              <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                Static App Share
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
                Ship a static app{" "}
                <span className="text-muted-foreground">in seconds.</span>
              </h1>
              <p className="max-w-md text-base text-muted-foreground text-pretty">
                Drop an HTML file, a ZIP, or a folder of static resources and get a
                shareable live preview link instantly.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={tokenRequired ? "default" : "secondary"} className="h-6 px-2.5">
                {tokenRequired ? "🔒 Protected upload" : "Public upload"}
              </Badge>
              <Badge variant="outline" className="h-6 px-2.5">{formatBytes(maxUploadBytes)} max</Badge>
              <Badge variant="outline" className="h-6 px-2.5">{retentionDays} day retention</Badge>
            </div>
          </section>

          <Card className="w-full shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">New share</CardTitle>
              <CardDescription>HTML, ZIP, or static resources</CardDescription>
              <CardAction>
                <Badge variant={status.tone === "error" ? "destructive" : "outline"}>
                  {isUploading ? "Uploading" : result ? "Ready" : "Idle"}
                </Badge>
              </CardAction>
            </CardHeader>

            <CardContent>
              <form id="uploadForm" onSubmit={handleSubmit}>
                <FieldGroup>
                  <Field data-invalid={status.tone === "error" && files.length === 0 ? true : undefined}>
                    <FieldLabel htmlFor="fileInput">Files</FieldLabel>
                    <input
                      ref={fileInputRef}
                      id="fileInput"
                      type="file"
                      multiple
                      className="sr-only"
                      disabled={isUploading}
                      onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}
                    />
                    <div
                      role="button"
                      tabIndex={isUploading ? -1 : 0}
                      aria-invalid={status.tone === "error" && files.length === 0}
                      onClick={() => !isUploading && fileInputRef.current?.click()}
                      onKeyDown={(event) => {
                        if ((event.key === "Enter" || event.key === " ") && !isUploading) {
                          event.preventDefault();
                          fileInputRef.current?.click();
                        }
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        if (!isUploading) setIsDragging(true);
                      }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDrop}
                      className={cn(
                        "group/drop flex min-h-[8.5rem] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-all outline-none",
                        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40",
                        isDragging
                          ? "border-primary bg-primary/10 scale-[1.01]"
                          : "border-border bg-muted/40 hover:border-primary/60 hover:bg-primary/5",
                        files.length > 0 && !isDragging && "border-primary/50 bg-primary/5",
                        isUploading && "pointer-events-none opacity-60",
                        status.tone === "error" && files.length === 0 && "border-destructive/50 bg-destructive/5",
                      )}
                    >
                      <div
                        className={cn(
                          "grid size-11 place-items-center rounded-full transition-colors",
                          files.length > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                        )}
                      >
                        {files.length > 0 ? (
                          <CheckCircle2Icon data-icon="inline-start" />
                        ) : (
                          <UploadCloudIcon data-icon="inline-start" />
                        )}
                      </div>
                      {files.length > 0 ? (
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium">{selectedFileMeta}</p>
                          <p className="text-xs text-muted-foreground">Click or drop to replace</p>
                        </div>
                      ) : (
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium">
                            <span className="text-primary">Click to browse</span> or drag files here
                          </p>
                          <p className="text-xs text-muted-foreground">
                            HTML, ZIP, or multiple files up to {formatBytes(maxUploadBytes)}
                          </p>
                        </div>
                      )}
                    </div>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="titleInput">Title</FieldLabel>
                    <Input
                      id="titleInput"
                      value={title}
                      maxLength={120}
                      placeholder="Optional"
                      disabled={isUploading}
                      onChange={(event) => setTitle(event.currentTarget.value)}
                    />
                  </Field>

                  {tokenRequired ? (
                    <Field data-invalid={status.tone === "error" && !uploadToken.trim() ? true : undefined}>
                      <FieldLabel htmlFor="tokenInput">Upload access token</FieldLabel>
                      <Input
                        id="tokenInput"
                        type="password"
                        value={uploadToken}
                        disabled={isUploading}
                        aria-invalid={status.tone === "error" && !uploadToken.trim()}
                        onChange={(event) => setUploadToken(event.currentTarget.value)}
                      />
                    </Field>
                  ) : null}

                  <Field>
                    <FieldLabel htmlFor="editTokenInput">Edit token</FieldLabel>
                    <Input
                      id="editTokenInput"
                      type="password"
                      value={editToken}
                      maxLength={256}
                      placeholder="Generated if blank"
                      disabled={isUploading}
                      onChange={(event) => setEditToken(event.currentTarget.value)}
                    />
                    <FieldDescription>Required later to add, patch, or delete resources.</FieldDescription>
                  </Field>

                  {progress > 0 ? (
                    <Field>
                      <div className="flex items-center justify-between gap-3">
                        <FieldLabel>Upload progress</FieldLabel>
                        <span className="text-sm text-muted-foreground">{progress}%</span>
                      </div>
                      <Progress value={progress} />
                    </Field>
                  ) : null}

                  {status.message ? (
                    <div
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                        status.tone === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
                        status.tone === "success" && "border-primary/25 bg-primary/10 text-foreground",
                        status.tone === "neutral" && "bg-muted text-muted-foreground",
                      )}
                    >
                      {status.tone === "error" ? (
                        <AlertTriangleIcon data-icon="inline-start" />
                      ) : status.tone === "success" ? (
                        <CheckCircle2Icon data-icon="inline-start" />
                      ) : (
                        <UploadCloudIcon data-icon="inline-start" />
                      )}
                      <span>{status.message}</span>
                    </div>
                  ) : null}

                  <Button
                    type="submit"
                    size="lg"
                    disabled={isUploading}
                    className="h-11 w-full text-base font-semibold"
                  >
                    <UploadCloudIcon data-icon="inline-start" />
                    {isUploading ? "Uploading…" : "Upload & get link"}
                  </Button>
                </FieldGroup>
              </form>
            </CardContent>

            {result ? (
              <CardFooter className="flex flex-col items-stretch gap-3">
                <Field>
                  <FieldLabel htmlFor="viewerLink">Viewer link</FieldLabel>
                  <div className="flex gap-2">
                    <Input id="viewerLink" value={result.viewerUrl} readOnly />
                    <Button type="button" variant="outline" size="icon" onClick={copyViewerLink}>
                      <CopyIcon data-icon="inline-start" />
                      <span className="sr-only">Copy</span>
                    </Button>
                  </div>
                </Field>
                <Field>
                  <FieldLabel htmlFor="resultEditToken">Edit token</FieldLabel>
                  <div className="flex gap-2">
                    <Input id="resultEditToken" value={result.editToken} readOnly />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        void copyText(result.editToken);
                        setStatus({ message: "Edit token copied.", tone: "success" });
                      }}
                    >
                      <CopyIcon data-icon="inline-start" />
                      <span className="sr-only">Copy edit token</span>
                    </Button>
                  </div>
                </Field>
                <Button asChild variant="secondary">
                  <a href={result.viewerUrl} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon data-icon="inline-start" />
                    Open viewer
                  </a>
                </Button>
                <Separator />
                <ResourceManager
                  uploadId={result.id}
                  initialResources={result.resources}
                  initialRevision={result.revision}
                  initialEditToken={result.editToken}
                  compact={false}
                />
              </CardFooter>
            ) : null}
          </Card>
        </div>
      </div>
    </main>
  );
}

const VIEWPORT_PRESETS = {
  "mobile-portrait": { label: "Phone", width: 390, height: 844, responsive: false },
  "mobile-landscape": { label: "Wide", width: 844, height: 390, responsive: false },
  tablet: { label: "Tablet", width: 820, height: 1180, responsive: false },
  desktop: { label: "Desktop", width: 1440, height: 900, responsive: false },
  responsive: { label: "Fluid", width: 1024, height: 720, responsive: true },
} as const;

type PresetKey = keyof typeof VIEWPORT_PRESETS | "custom";
type ZoomMode = "fit" | "50" | "75" | "100" | "125" | "custom";

function ViewerApp({ root }: StaticShareAppProps) {
  const uploadId = root.dataset.uploadId || "";
  const viewerUrl = root.dataset.viewerUrl || window.location.href;
  const expiresAt = root.dataset.expiresAt || "";
  const title = root.dataset.title || "Uploaded app";
  const initialContentUrl = root.dataset.contentUrl || "";
  const initialRevision = Number(root.dataset.resourceRevision || 1);
  const stageRef = useRef<HTMLElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 1024, height: 720 });
  const [preset, setPreset] = useState<PresetKey>("mobile-portrait");
  const [width, setWidth] = useState(390);
  const [height, setHeight] = useState(844);
  const [responsive, setResponsive] = useState(false);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");
  const [zoomPercent, setZoomPercent] = useState(100);
  const [frame, setFrame] = useState(true);
  const [showDims, setShowDims] = useState(false);
  const [safeArea, setSafeArea] = useState(false);
  const [dark, setDark] = useState(false);
  const [contentUrl, setContentUrl] = useState(initialContentUrl);
  const [resourceRevision, setResourceRevision] = useState(initialRevision);
  const [frameSrc, setFrameSrc] = useState(initialContentUrl);
  const [copied, setCopied] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(readViewerChromeVisible);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    return () => document.documentElement.classList.remove("dark");
  }, [dark]);

  useEffect(() => {
    saveViewerChromeVisible(controlsVisible);
  }, [controlsVisible]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !controlsVisible) {
        setControlsVisible(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [controlsVisible]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) {
      return;
    }
    const update = () => {
      const rect = element.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const frameMetrics = useMemo(() => {
    const stageInset = controlsVisible ? 32 : 16;
    const availableWidth = Math.max(240, stageSize.width - stageInset);
    const availableHeight = Math.max(240, stageSize.height - stageInset);
    const frameWidth = responsive ? Math.round(availableWidth) : width;
    const frameHeight = responsive ? Math.round(Math.max(360, availableHeight)) : height;
    const fitScale = Math.min(1, availableWidth / frameWidth, availableHeight / frameHeight);
    const scale = zoomMode === "fit" ? fitScale : zoomPercent / 100;
    return {
      frameWidth,
      frameHeight,
      scale,
      scaledWidth: Math.round(frameWidth * scale),
      scaledHeight: Math.round(frameHeight * scale),
    };
  }, [controlsVisible, height, responsive, stageSize.height, stageSize.width, width, zoomMode, zoomPercent]);

  function applyPreset(value: string) {
    if (!value) {
      return;
    }
    const key = value as PresetKey;
    setPreset(key);
    if (key === "custom") {
      setResponsive(false);
      return;
    }
    const next = VIEWPORT_PRESETS[key];
    setWidth(next.width);
    setHeight(next.height);
    setResponsive(next.responsive);
  }

  function updateWidth(value: string) {
    setWidth(clamp(Number(value), 240, 3840));
    setResponsive(false);
    setPreset("custom");
  }

  function updateHeight(value: string) {
    setHeight(clamp(Number(value), 240, 3000));
    setResponsive(false);
    setPreset("custom");
  }

  function rotateFrame() {
    setWidth(height);
    setHeight(width);
    setResponsive(false);
    setPreset("custom");
  }

  function refreshFrame() {
    setFrameSrc(`${contentUrl}${contentUrl.includes("?") ? "&" : "?"}refresh=${Date.now()}`);
  }

  function handleResourcesChanged(payload: ResourcePayload) {
    const refreshedUrl = `${payload.contentUrl}${payload.contentUrl.includes("?") ? "&" : "?"}refresh=${Date.now()}`;
    setResourceRevision(payload.revision);
    setContentUrl(payload.contentUrl);
    setFrameSrc(refreshedUrl);
  }

  async function copyViewer() {
    await copyText(viewerUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function updateZoomMode(value: ZoomMode) {
    setZoomMode(value);
    if (value !== "fit" && value !== "custom") {
      setZoomPercent(Number(value));
    }
  }

  function updateZoomPercent(value: string) {
    setZoomPercent(clamp(Number(value), 25, 200));
    setZoomMode("custom");
  }

  const dimensionLabel = `${frameMetrics.frameWidth} x ${frameMetrics.frameHeight}`;

  return (
    <main className="relative flex h-screen min-h-screen flex-col overflow-hidden bg-background">
      {controlsVisible ? (
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-card/95 px-2 py-1.5 backdrop-blur md:px-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
              <LinkIcon data-icon="inline-start" />
            </div>
            <div className="min-w-0">
              <p className="sr-only">Static App Share</p>
              <h1 className="truncate text-sm font-semibold tracking-normal">{title}</h1>
            </div>
          </div>

          <Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
            {dimensionLabel} at {Math.round(frameMetrics.scale * 100)}%
          </Badge>
          <Badge variant="outline" className="hidden shrink-0 md:inline-flex">
            Expires {formatDateTime(expiresAt)}
          </Badge>
          <Badge variant="outline" className="hidden shrink-0 lg:inline-flex">
            Rev {resourceRevision}
          </Badge>

          <div className="flex shrink-0 items-center gap-1">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="Viewer controls">
                  <Settings2Icon data-icon="inline-start" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(calc(100vw-1rem),30rem)] gap-3 p-3">
                <PopoverHeader>
                  <PopoverTitle>Viewer controls</PopoverTitle>
                  <PopoverDescription>
                    {dimensionLabel} at {Math.round(frameMetrics.scale * 100)}%
                  </PopoverDescription>
                </PopoverHeader>
                <FieldGroup className="gap-3">
                  <Field className="gap-2">
                    <FieldLabel id="viewportLabel">Viewport</FieldLabel>
                    <ToggleGroup
                      aria-labelledby="viewportLabel"
                      type="single"
                      value={preset}
                      variant="outline"
                      size="sm"
                      spacing={1}
                      className="flex-wrap justify-start"
                      onValueChange={applyPreset}
                    >
                      {Object.entries(VIEWPORT_PRESETS).map(([key, item]) => (
                        <ToggleGroupItem key={key} value={key}>
                          {item.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </Field>

                  <FieldGroup className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                    <CompactNumberField
                      id="widthInput"
                      label="Width"
                      min={240}
                      max={3840}
                      value={width}
                      onChange={updateWidth}
                    />
                    <CompactNumberField
                      id="heightInput"
                      label="Height"
                      min={240}
                      max={3000}
                      value={height}
                      onChange={updateHeight}
                    />
                    <TooltipButton label="Rotate" type="button" variant="outline" size="icon-sm" onClick={rotateFrame}>
                      <RotateCwIcon data-icon="inline-start" />
                    </TooltipButton>
                  </FieldGroup>

                  <FieldGroup className="grid grid-cols-[1fr_6rem] gap-2">
                    <Field className="gap-1.5">
                      <FieldLabel>Zoom</FieldLabel>
                      <Select value={zoomMode} onValueChange={(value) => updateZoomMode(value as ZoomMode)}>
                        <SelectTrigger size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="fit">Fit</SelectItem>
                            <SelectItem value="50">50%</SelectItem>
                            <SelectItem value="75">75%</SelectItem>
                            <SelectItem value="100">100%</SelectItem>
                            <SelectItem value="125">125%</SelectItem>
                            <SelectItem value="custom">Custom</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <CompactNumberField
                      id="zoomInput"
                      label="Percent"
                      min={25}
                      max={200}
                      step={5}
                      value={zoomPercent}
                      onChange={updateZoomPercent}
                    />
                  </FieldGroup>

                  <Separator />

                  <FieldGroup data-slot="checkbox-group" className="grid grid-cols-3 gap-2">
                    <ViewerCheckbox id="frameToggle" checked={frame} onChange={setFrame} title="Frame" />
                    <ViewerCheckbox id="dimsToggle" checked={showDims} onChange={setShowDims} title="Dims" />
                    <ViewerCheckbox id="safeAreaToggle" checked={safeArea} onChange={setSafeArea} title="Safe" />
                  </FieldGroup>
                </FieldGroup>
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="Resources">
                  <FileArchiveIcon data-icon="inline-start" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(calc(100vw-1rem),32rem)] gap-3 p-3">
                <PopoverHeader>
                  <PopoverTitle>Resources</PopoverTitle>
                  <PopoverDescription>Revision {resourceRevision}</PopoverDescription>
                </PopoverHeader>
                <ResourceManager
                  uploadId={uploadId}
                  initialResources={[]}
                  initialRevision={resourceRevision}
                  initialEditToken=""
                  compact
                  onChanged={handleResourcesChanged}
                />
              </PopoverContent>
            </Popover>
            <TooltipButton label={copied ? "Copied" : "Copy link"} variant="outline" size="icon-sm" onClick={copyViewer}>
              <CopyIcon data-icon="inline-start" />
            </TooltipButton>
            <TooltipButton label="Open app" variant="outline" size="icon-sm" asChild>
              <a href={contentUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon data-icon="inline-start" />
              </a>
            </TooltipButton>
            <TooltipButton label="Refresh" variant="outline" size="icon-sm" onClick={refreshFrame}>
              <RefreshCcwIcon data-icon="inline-start" />
            </TooltipButton>
            <TooltipButton
              label={dark ? "Light mode" : "Dark mode"}
              variant="ghost"
              size="icon-sm"
              aria-pressed={dark}
              onClick={() => setDark((value) => !value)}
            >
              {dark ? <SunIcon data-icon="inline-start" /> : <MoonIcon data-icon="inline-start" />}
            </TooltipButton>
            <TooltipButton label="Focus" variant="ghost" size="icon-sm" onClick={() => setControlsVisible(false)}>
              <EyeOffIcon data-icon="inline-start" />
            </TooltipButton>
          </div>
        </header>
      ) : (
        <div className="fixed right-3 top-3 z-50">
          <TooltipButton
            label="Show controls"
            type="button"
            variant="secondary"
            size="sm"
            className="border bg-card/90 shadow-lg backdrop-blur"
            onClick={() => setControlsVisible(true)}
          >
            <EyeIcon data-icon="inline-start" />
            Show controls
          </TooltipButton>
        </div>
      )}

      <section
        ref={stageRef}
        className={cn(
          "app-shell-bg min-h-0 flex-1 overflow-auto",
          controlsVisible ? "p-2 md:p-4" : "p-1 md:p-2",
        )}
      >
        <div
          className="mx-auto"
          style={{
            width: frameMetrics.scaledWidth,
            height: frameMetrics.scaledHeight,
          }}
        >
          <div
            style={{
              width: frameMetrics.frameWidth,
              height: frameMetrics.frameHeight,
              transform: `scale(${frameMetrics.scale})`,
              transformOrigin: "top left",
            }}
          >
            <div
              className={cn(
                "relative overflow-hidden bg-background shadow-2xl shadow-foreground/15",
                frame
                  ? "rounded-[1.8rem] border-[12px] border-foreground/85"
                  : "rounded-lg border bg-card",
              )}
              style={{ width: frameMetrics.frameWidth, height: frameMetrics.frameHeight }}
            >
              {showDims ? (
                <Badge className="absolute right-2 top-2 z-10" variant="secondary">
                  {dimensionLabel}
                </Badge>
              ) : null}
              {safeArea ? (
                <div className="pointer-events-none absolute inset-0 z-10 border-[24px] border-primary/15 outline outline-1 -outline-offset-[24px] outline-primary/70" />
              ) : null}
              <iframe
                title="Uploaded app"
                src={frameSrc}
                sandbox="allow-scripts allow-forms allow-pointer-lock"
                referrerPolicy="no-referrer"
                className="block size-full border-0 bg-background"
              />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function ResourceManager({
  uploadId,
  initialResources,
  initialRevision,
  initialEditToken,
  compact,
  onChanged,
}: {
  uploadId: string;
  initialResources: ResourceInfo[];
  initialRevision: number;
  initialEditToken: string;
  compact: boolean;
  onChanged?: (payload: ResourcePayload) => void;
}) {
  const [resources, setResources] = useState<ResourceInfo[]>(initialResources);
  const [revision, setRevision] = useState(initialRevision);
  const [editToken, setEditToken] = useState(initialEditToken);
  const [resourcePath, setResourcePath] = useState("");
  const [resourceFile, setResourceFile] = useState<File | null>(null);
  const [status, setStatus] = useState<StatusState>({ message: "", tone: "neutral" });
  const [busy, setBusy] = useState(false);
  const resourceInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setResources(initialResources);
    setRevision(initialRevision);
    setEditToken(initialEditToken);
    setStatus({ message: "", tone: "neutral" });
    if (uploadId) {
      void refreshResources();
    }
  }, [uploadId]);

  async function refreshResources() {
    if (!uploadId) {
      return;
    }
    try {
      const payload = await fetchResourcePayload(uploadId);
      setResources(payload.resources);
      setRevision(payload.revision);
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Could not load resources.",
        tone: "error",
      });
    }
  }

  async function handleResourceUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resourceFile) {
      setStatus({ message: "Choose a resource file.", tone: "error" });
      resourceInputRef.current?.focus();
      return;
    }
    if (!editToken.trim()) {
      setStatus({ message: "Edit token is required.", tone: "error" });
      return;
    }

    const formData = new FormData();
    formData.set("file", resourceFile);
    if (resourcePath.trim()) {
      formData.set("path", resourcePath.trim());
    }

    try {
      setBusy(true);
      const payload = await mutateResourcePayload(uploadId, editToken, {
        method: "POST",
        body: formData,
      });
      applyResourcePayload(payload);
      setResourceFile(null);
      setResourcePath("");
      if (resourceInputRef.current) {
        resourceInputRef.current.value = "";
      }
      setStatus({ message: `Saved revision ${payload.revision}.`, tone: "success" });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Resource upload failed.",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(path: string) {
    if (!editToken.trim()) {
      setStatus({ message: "Edit token is required.", tone: "error" });
      return;
    }

    try {
      setBusy(true);
      const payload = await mutateResourcePayload(uploadId, editToken, {
        method: "DELETE",
        path,
      });
      applyResourcePayload(payload);
      setStatus({ message: `Deleted ${path}.`, tone: "success" });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Delete failed.",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  function applyResourcePayload(payload: ResourcePayload) {
    setResources(payload.resources);
    setRevision(payload.revision);
    onChanged?.(payload);
  }

  return (
    <div className={cn("flex flex-col gap-3", compact ? "text-sm" : "w-full")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRoundIcon data-icon="inline-start" />
          <span className="text-sm font-medium">Revision {revision}</span>
        </div>
        <Badge variant="outline">{resources.length} files</Badge>
      </div>

      <form onSubmit={handleResourceUpload}>
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor={`resourceToken-${uploadId}`}>Edit token</FieldLabel>
            <Input
              id={`resourceToken-${uploadId}`}
              type="password"
              value={editToken}
              maxLength={256}
              disabled={busy}
              onChange={(event) => setEditToken(event.currentTarget.value)}
            />
          </Field>

          <FieldGroup className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Field>
              <FieldLabel htmlFor={`resourceFile-${uploadId}`}>Resource</FieldLabel>
              <Input
                ref={resourceInputRef}
                id={`resourceFile-${uploadId}`}
                type="file"
                disabled={busy}
                onChange={(event) => setResourceFile(event.currentTarget.files?.[0] ?? null)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`resourcePath-${uploadId}`}>Path</FieldLabel>
              <Input
                id={`resourcePath-${uploadId}`}
                value={resourcePath}
                maxLength={512}
                placeholder={resourceFile?.name || "index.html"}
                disabled={busy}
                onChange={(event) => setResourcePath(event.currentTarget.value)}
              />
            </Field>
          </FieldGroup>

          <Button type="submit" variant="secondary" disabled={busy} className="w-full">
            <UploadCloudIcon data-icon="inline-start" />
            {busy ? "Saving" : "Add or replace"}
          </Button>
        </FieldGroup>
      </form>

      {status.message ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
            status.tone === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
            status.tone === "success" && "border-primary/25 bg-primary/10 text-foreground",
            status.tone === "neutral" && "bg-muted text-muted-foreground",
          )}
        >
          {status.tone === "error" ? (
            <AlertTriangleIcon data-icon="inline-start" />
          ) : status.tone === "success" ? (
            <CheckCircle2Icon data-icon="inline-start" />
          ) : (
            <UploadCloudIcon data-icon="inline-start" />
          )}
          <span className="min-w-0 truncate">{status.message}</span>
        </div>
      ) : null}

      <div className={cn("overflow-auto rounded-lg border", compact ? "max-h-64" : "max-h-80")}>
        {resources.length ? (
          resources.map((resource) => (
            <div key={resource.path} className="flex min-h-10 items-center gap-2 border-b px-2 py-1.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{resource.path}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(resource.bytes)} - {resource.contentType}
                </p>
              </div>
              <TooltipButton
                label={`Delete ${resource.path}`}
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                onClick={() => void handleDelete(resource.path)}
              >
                <Trash2Icon data-icon="inline-start" />
              </TooltipButton>
            </div>
          ))
        ) : (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">No resources</div>
        )}
      </div>
    </div>
  );
}

function CompactNumberField({
  id,
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: string) => void;
}) {
  return (
    <Field className="min-w-0 gap-1.5">
      <FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </FieldLabel>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        className="h-7 w-full px-2"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

function TooltipButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & {
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props} aria-label={props["aria-label"] ?? label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function ViewerCheckbox({
  id,
  checked,
  onChange,
  title,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
}) {
  return (
    <Field orientation="horizontal" className="w-auto">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <FieldContent>
        <FieldTitle>
          <FieldLabel htmlFor={id}>{title}</FieldLabel>
        </FieldTitle>
      </FieldContent>
    </Field>
  );
}

function uploadHeaders(token: string): Headers {
  const headers = new Headers();
  if (token) {
    saveToken(token);
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    forgetToken();
  }
  return headers;
}

async function checkToken(headers: Headers): Promise<void> {
  const response = await fetch("/api/auth-check", {
    method: "GET",
    headers,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Token check failed with ${response.status}.`);
  }
}

function uploadFormData(
  formData: FormData,
  headers: Headers,
  onProgress: (percent: number, loaded: number, total: number) => void,
): Promise<UploadPayload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    headers.forEach((value, key) => {
      xhr.setRequestHeader(key, value);
    });
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }
      const percent = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
      onProgress(percent, event.loaded, event.total);
    });
    xhr.addEventListener("load", () => {
      const payload = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as UploadPayload);
        return;
      }
      reject(new Error(typeof payload.error === "string" ? payload.error : `Upload failed with ${xhr.status}.`));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error while uploading.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled.")));
    xhr.send(formData);
  });
}

async function fetchResourcePayload(uploadId: string): Promise<ResourcePayload> {
  const response = await fetch(`/api/uploads/${uploadId}/resources`, {
    method: "GET",
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Resource list failed with ${response.status}.`);
  }
  return payload as ResourcePayload;
}

async function mutateResourcePayload(
  uploadId: string,
  editToken: string,
  options: { method: "POST"; body: FormData } | { method: "DELETE"; path: string },
): Promise<ResourcePayload> {
  const path = options.method === "DELETE" ? `/${encodeResourcePath(options.path)}` : "";
  const response = await fetch(`/api/uploads/${uploadId}/resources${path}`, {
    method: options.method,
    headers: editHeaders(editToken),
    body: options.method === "POST" ? options.body : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Resource change failed with ${response.status}.`);
  }
  return payload as ResourcePayload;
}

function editHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function encodeResourcePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function readSavedToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Ignore storage failures.
  }
}

function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function readViewerChromeVisible(): boolean {
  try {
    return localStorage.getItem(VIEWER_CHROME_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveViewerChromeVisible(value: boolean): void {
  try {
    localStorage.setItem(VIEWER_CHROME_STORAGE_KEY, value ? "true" : "false");
  } catch {
    // Ignore storage failures.
  }
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${Math.round(value / 1024 / 1024)} MB`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}
