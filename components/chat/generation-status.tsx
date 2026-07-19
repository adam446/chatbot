"use client";

import { cn } from "@/lib/utils";
import { useDataStream } from "./data-stream-provider";

function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getOutcomeLabel(outcome: string) {
  switch (outcome) {
    case "completed":
      return "Completed";
    case "error":
      return "Generation failed";
    case "stopped":
      return "Generation stopped";
    default:
      return "Thinking";
  }
}

export function GenerationStatus({ className }: { className?: string }) {
  const { generationElapsedMs, generationOutcome, waitingStatus } =
    useDataStream();

  if (generationOutcome === "idle") {
    return null;
  }

  const label =
    generationOutcome === "active"
      ? (waitingStatus?.message ?? "Thinking...")
      : getOutcomeLabel(generationOutcome);

  return (
    <div
      aria-live="polite"
      className={cn(
        "flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground",
        className
      )}
      data-testid="generation-status"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-muted-foreground/60",
          generationOutcome === "active" && "animate-pulse bg-foreground"
        )}
      />
      <span className="truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground/70">
        {formatElapsed(generationElapsedMs)}
      </span>
    </div>
  );
}
