"use client";

import { Armchair } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useSeats } from "./seats-provider";

export function SeatsDisplay() {
  const { available, capacity, status } = useSeats();

  if (available === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Armchair className="size-4" aria-hidden="true" />
        The number of free seats is not available right now. The rest of the page still works.
      </p>
    );
  }

  const soldOut = available === 0;
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-2" aria-live="polite" aria-atomic="true">
        <Armchair className="size-5" aria-hidden="true" />
        <span className={cn("text-2xl font-semibold tabular-nums", soldOut && "text-destructive")} data-testid="seats-left">
          {available}
        </span>
        <span className="text-sm text-muted-foreground">
          {soldOut ? "seats left: sold out" : `of ${capacity} seats left`}
        </span>
      </p>
      {status === "reconnecting" && (
        <p className="text-xs text-muted-foreground" role="status">
          Live updates are paused. Reconnecting…
        </p>
      )}
    </div>
  );
}
