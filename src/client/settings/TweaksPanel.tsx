import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { TweakDef, TweakValue } from "../inspector/protocol";

type TweaksPanelProps = {
  tweaks: TweakDef[];
  onChange: (id: string, value: TweakValue) => void;
};

// Renders one live control per tweak the page exposed, grouped by `group`. Changes flow straight
// back to the page (live preview); persistence is a separate, password-gated action in Settings.
export function TweaksPanel({ tweaks, onChange }: TweaksPanelProps) {
  const groups = useMemo(() => groupTweaks(tweaks), [tweaks]);

  if (tweaks.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-muted-foreground">This page exposes no tweaks.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.name} className="flex flex-col gap-3">
          {group.name ? (
            <p className="font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">{group.name}</p>
          ) : null}
          {group.tweaks.map((tweak) => (
            <TweakControl key={tweak.id} tweak={tweak} onChange={onChange} />
          ))}
        </div>
      ))}
    </div>
  );
}

function TweakControl({ tweak, onChange }: { tweak: TweakDef; onChange: (id: string, value: TweakValue) => void }) {
  if (tweak.kind === "toggle") {
    return (
      <Field orientation="horizontal" className="w-auto justify-between">
        <FieldLabel htmlFor={`tweak-${tweak.id}`}>{tweak.label}</FieldLabel>
        <Checkbox
          id={`tweak-${tweak.id}`}
          checked={Boolean(tweak.value)}
          onCheckedChange={(value) => onChange(tweak.id, value === true)}
        />
      </Field>
    );
  }

  if (tweak.kind === "select") {
    const options = tweak.options ?? [];
    return (
      <Field className="gap-1.5">
        <FieldLabel htmlFor={`tweak-${tweak.id}`}>{tweak.label}</FieldLabel>
        <Select value={String(tweak.value)} onValueChange={(value) => onChange(tweak.id, value)}>
          <SelectTrigger id={`tweak-${tweak.id}`} size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.map((option) => (
                <SelectItem key={option} value={option} className="font-mono text-xs">
                  {option}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    );
  }

  if (tweak.kind === "color") {
    return (
      <Field orientation="horizontal" className="w-auto justify-between">
        <FieldLabel htmlFor={`tweak-${tweak.id}`}>{tweak.label}</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{String(tweak.value)}</span>
          <input
            id={`tweak-${tweak.id}`}
            type="color"
            value={normalizeColor(tweak.value)}
            onChange={(event) => onChange(tweak.id, event.currentTarget.value)}
            className="size-7 cursor-pointer rounded-md border bg-transparent p-0.5"
          />
        </div>
      </Field>
    );
  }

  if (tweak.kind === "number") {
    const value = typeof tweak.value === "number" ? tweak.value : Number(tweak.value) || 0;
    const hasRange = typeof tweak.min === "number" && typeof tweak.max === "number";
    return (
      <Field className="gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`tweak-${tweak.id}`}>{tweak.label}</FieldLabel>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {value}
            {tweak.unit ?? ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {hasRange ? (
            <input
              type="range"
              min={tweak.min}
              max={tweak.max}
              step={tweak.step ?? 1}
              value={value}
              onChange={(event) => onChange(tweak.id, Number(event.currentTarget.value))}
              className="h-1.5 flex-1 cursor-pointer accent-primary"
              aria-label={tweak.label}
            />
          ) : null}
          <Input
            id={`tweak-${tweak.id}`}
            type="number"
            min={tweak.min}
            max={tweak.max}
            step={tweak.step}
            value={value}
            className={cn("h-7 font-mono tabular-nums", hasRange ? "w-20" : "w-full")}
            onChange={(event) => onChange(tweak.id, Number(event.currentTarget.value))}
          />
        </div>
      </Field>
    );
  }

  // text
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={`tweak-${tweak.id}`}>{tweak.label}</FieldLabel>
      <Input
        id={`tweak-${tweak.id}`}
        value={String(tweak.value)}
        onChange={(event) => onChange(tweak.id, event.currentTarget.value)}
      />
    </Field>
  );
}

function groupTweaks(tweaks: TweakDef[]): Array<{ name: string; tweaks: TweakDef[] }> {
  const order: string[] = [];
  const byGroup = new Map<string, TweakDef[]>();
  for (const tweak of tweaks) {
    const name = tweak.group ?? "";
    if (!byGroup.has(name)) {
      byGroup.set(name, []);
      order.push(name);
    }
    byGroup.get(name)!.push(tweak);
  }
  return order.map((name) => ({ name, tweaks: byGroup.get(name)! }));
}

// <input type="color"> requires a 6-digit hex; coerce anything else to a neutral default so the
// swatch still renders (the underlying tweak value is unchanged until the user edits it).
function normalizeColor(value: TweakValue): string {
  const text = String(value).trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) {
    return text;
  }
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  return "#000000";
}

// Used by Settings to persist the live tweak values to the share.
export function currentTweakValues(tweaks: TweakDef[]): Record<string, TweakValue> {
  const values: Record<string, TweakValue> = {};
  for (const tweak of tweaks) {
    values[tweak.id] = tweak.value;
  }
  return values;
}
