import { useEffect, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  UploadCloudIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ResourceManager } from "../static-share-app";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UploadSettings = {
  id: string;
  passwordRequired: boolean;
  homepage: string | null;
  exposed: string[];
  barDefault: boolean;
  htmlPages: string[];
};

type StatusState = {
  message: string;
  tone: "neutral" | "success" | "error";
};

// ---------------------------------------------------------------------------
// Fetch helpers (mirrors fetchResourcePayload / mutateResourcePayload patterns)
// ---------------------------------------------------------------------------

async function fetchSettings(uploadId: string): Promise<UploadSettings> {
  const response = await fetch(`/api/uploads/${uploadId}/settings`, {
    method: "GET",
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Failed to load settings (${response.status}).`,
    );
  }
  return payload as UploadSettings;
}

async function patchSettings(
  uploadId: string,
  password: string,
  passwordRequired: boolean,
  body: Partial<{
    homepage: string | null;
    exposed: string[];
    barDefault: boolean;
    password: string | null;
    tweaks: Record<string, string | number | boolean>;
  }>,
): Promise<UploadSettings> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (password || passwordRequired) {
    headers.set("Authorization", `Bearer ${password}`);
  }
  const response = await fetch(`/api/uploads/${uploadId}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    throw new Error("Wrong password.");
  }
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Save failed (${response.status}).`,
    );
  }
  return payload as UploadSettings;
}

// ---------------------------------------------------------------------------
// StatusPill — mirrors ResourceManager's status block styling
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: StatusState }) {
  if (!status.message) return null;
  return (
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
  );
}

// ---------------------------------------------------------------------------
// SettingsPanel
// ---------------------------------------------------------------------------

export function SettingsPanel({
  uploadId,
  contentRoot: _contentRoot,
  resourceRevision,
  onHomeChanged,
}: {
  uploadId: string;
  contentRoot: string;
  resourceRevision: number;
  onHomeChanged?: () => void;
}) {
  const [settings, setSettings] = useState<UploadSettings | null>(null);
  const [loadStatus, setLoadStatus] = useState<StatusState>({ message: "", tone: "neutral" });

  // Shared password state — used for auth on both workspace and password update calls
  const [password, setPassword] = useState("");

  // Workspace form local state (driven from settings once loaded)
  const [homepage, setHomepage] = useState<string | null>(null);
  const [exposed, setExposed] = useState<string[]>([]);
  const [barDefault, setBarDefault] = useState(true);
  const [workspaceStatus, setWorkspaceStatus] = useState<StatusState>({ message: "", tone: "neutral" });
  const [workspaceBusy, setWorkspaceBusy] = useState(false);

  // Change password form
  const [newPassword, setNewPassword] = useState("");
  const [pwStatus, setPwStatus] = useState<StatusState>({ message: "", tone: "neutral" });
  const [pwBusy, setPwBusy] = useState(false);

  // Load settings on mount
  useEffect(() => {
    if (!uploadId) return;
    setLoadStatus({ message: "Loading…", tone: "neutral" });
    fetchSettings(uploadId)
      .then((data) => {
        setSettings(data);
        setHomepage(data.homepage);
        setExposed(data.exposed);
        setBarDefault(data.barDefault);
        setLoadStatus({ message: "", tone: "neutral" });
      })
      .catch((err: unknown) => {
        setLoadStatus({
          message: err instanceof Error ? err.message : "Could not load settings.",
          tone: "error",
        });
      });
  }, [uploadId]);

  function toggleExposed(page: string, checked: boolean) {
    setExposed((prev) =>
      checked ? (prev.includes(page) ? prev : [...prev, page]) : prev.filter((p) => p !== page),
    );
  }

  async function handleSaveWorkspace() {
    if (!settings) return;
    setWorkspaceBusy(true);
    setWorkspaceStatus({ message: "", tone: "neutral" });
    const prevHomepage = settings.homepage;
    try {
      const updated = await patchSettings(uploadId, password, settings.passwordRequired, {
        homepage,
        exposed,
        barDefault,
      });
      setSettings(updated);
      setHomepage(updated.homepage);
      setExposed(updated.exposed);
      setBarDefault(updated.barDefault);
      setWorkspaceStatus({ message: "Settings saved.", tone: "success" });
      if (updated.homepage !== prevHomepage) {
        onHomeChanged?.();
      }
    } catch (err: unknown) {
      setWorkspaceStatus({
        message: err instanceof Error ? err.message : "Save failed.",
        tone: "error",
      });
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function handleUpdatePassword() {
    if (!settings) return;
    setPwBusy(true);
    setPwStatus({ message: "", tone: "neutral" });
    try {
      const updated = await patchSettings(uploadId, password, settings.passwordRequired, {
        password: newPassword || null,
      });
      setSettings(updated);
      // If the password was changed, update shared password so subsequent saves work
      setPassword(newPassword);
      setNewPassword("");
      setPwStatus({
        message: newPassword ? "Password updated." : "Password cleared.",
        tone: "success",
      });
    } catch (err: unknown) {
      setPwStatus({
        message: err instanceof Error ? err.message : "Password update failed.",
        tone: "error",
      });
    } finally {
      setPwBusy(false);
    }
  }

  if (!settings && loadStatus.message) {
    return <StatusPill status={loadStatus} />;
  }

  const htmlPages = settings?.htmlPages ?? [];
  const passwordRequired = settings?.passwordRequired ?? false;

  return (
    <div className="flex flex-col gap-4">
      {/* Authentication */}
      <FieldGroup className="gap-3">
        <div className="flex items-center gap-2">
          <KeyRoundIcon data-icon="inline-start" className="text-muted-foreground" />
          <span className="font-mono text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Authentication
          </span>
          <Badge variant={passwordRequired ? "default" : "outline"} className="ml-auto font-mono text-xs">
            {passwordRequired ? "LOCKED" : "PUBLIC"}
          </Badge>
        </div>
        <Field>
          <FieldLabel htmlFor="settings-password">Password</FieldLabel>
          <Input
            id="settings-password"
            type="password"
            value={password}
            maxLength={256}
            placeholder={passwordRequired ? "Required to save changes" : "No password set"}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <FieldDescription>
            {passwordRequired
              ? "Required to save changes."
              : "No password — anyone with the link can edit. Set one below to lock editing."}
          </FieldDescription>
        </Field>
      </FieldGroup>

      <Separator />

      {/* Workspace settings */}
      <FieldGroup className="gap-3">
        <p className="font-mono text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Workspace
        </p>

        <Field>
          <FieldLabel htmlFor="settings-homepage">Homepage</FieldLabel>
          <Select
            value={homepage ?? "__default__"}
            onValueChange={(val) => setHomepage(val === "__default__" ? null : val)}
          >
            <SelectTrigger id="settings-homepage" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="__default__" className="font-mono text-xs">
                  Default (index)
                </SelectItem>
                {htmlPages.map((page) => (
                  <SelectItem key={page} value={page} className="font-mono text-xs">
                    {page}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>The page loaded when visitors open the share link.</FieldDescription>
        </Field>

        {htmlPages.length > 0 ? (
          <Field>
            <FieldLabel>Exposed pages</FieldLabel>
            <FieldDescription className="mb-1.5">
              Pages shown in the page switcher.
            </FieldDescription>
            <div className="flex flex-col gap-1.5">
              {htmlPages.map((page) => (
                <Field key={page} orientation="horizontal" className="w-auto">
                  <Checkbox
                    id={`exposed-${page}`}
                    checked={exposed.includes(page)}
                    onCheckedChange={(val) => toggleExposed(page, val === true)}
                  />
                  <FieldContent>
                    <FieldTitle>
                      <FieldLabel htmlFor={`exposed-${page}`} className="font-mono text-xs">
                        {page}
                      </FieldLabel>
                    </FieldTitle>
                  </FieldContent>
                </Field>
              ))}
            </div>
          </Field>
        ) : null}

        <Field orientation="horizontal" className="w-auto">
          <Checkbox
            id="settings-bar-default"
            checked={barDefault}
            onCheckedChange={(val) => setBarDefault(val === true)}
          />
          <FieldContent>
            <FieldTitle>
              <FieldLabel htmlFor="settings-bar-default">Show inspector bar by default</FieldLabel>
            </FieldTitle>
            <FieldDescription>
              New visitors will see the viewer toolbar on first load.
            </FieldDescription>
          </FieldContent>
        </Field>

        <StatusPill status={workspaceStatus} />

        <Button
          type="button"
          variant="secondary"
          disabled={workspaceBusy || !settings}
          className="w-full"
          onClick={() => void handleSaveWorkspace()}
        >
          {workspaceBusy ? "Saving…" : "Save settings"}
        </Button>
      </FieldGroup>

      <Separator />

      {/* Change password */}
      <FieldGroup className="gap-3">
        <p className="font-mono text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Change password
        </p>
        <Field>
          <FieldLabel htmlFor="settings-new-password">New password</FieldLabel>
          <Input
            id="settings-new-password"
            type="password"
            value={newPassword}
            maxLength={256}
            placeholder="Leave empty to allow link-only editing"
            onChange={(e) => setNewPassword(e.currentTarget.value)}
          />
          <FieldDescription>
            Leave empty to clear the password and allow anyone with the link to edit.
          </FieldDescription>
        </Field>

        <StatusPill status={pwStatus} />

        <Button
          type="button"
          variant="secondary"
          disabled={pwBusy || !settings}
          className="w-full"
          onClick={() => void handleUpdatePassword()}
        >
          {pwBusy ? "Updating…" : "Update password"}
        </Button>
      </FieldGroup>

      <Separator />

      {/* Content / resources */}
      <FieldGroup className="gap-3">
        <p className="font-mono text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Content
        </p>
        <ResourceManager
          uploadId={uploadId}
          initialResources={[]}
          initialRevision={resourceRevision}
          initialEditToken={password}
          compact
        />
      </FieldGroup>
    </div>
  );
}
