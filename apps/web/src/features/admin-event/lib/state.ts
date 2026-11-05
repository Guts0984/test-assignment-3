import type { EventDto } from "@app/shared";

/** What the edit form shows after a save attempt. */
export type EditEventState =
  | { status: "idle" }
  | { status: "saved"; event: EventDto }
  | { status: "invalid"; fields: Record<string, string[]>; submitted: Submitted }
  /** Someone else saved first: `current` is what is saved now, `submitted` is what this editor typed. */
  | { status: "conflict"; current: EventDto; submitted: Submitted }
  | { status: "failed"; message: string; submitted: Submitted };

export interface Submitted {
  title: string;
  description: string;
  capacity: string;
}

export const initialEditState: EditEventState = { status: "idle" };
