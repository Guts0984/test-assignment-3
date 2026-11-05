"use server";

import { eventSchema, updateEventBodySchema, issuesToFieldErrors, parseEventId } from "@app/shared";
import { updateTag } from "next/cache";
import { z } from "zod";
import { CITIES_TAG, EVENTS_TAG, eventTag } from "@/features/event/server";
import { apiCall, isApiRequestError } from "@/shared/api/api-client";
import { getRequestContext } from "@/shared/api/request-context";
import { logger } from "@/shared/logger";
import type { EditEventState, Submitted } from "./lib/state";

const eventConflictDetails = z.object({ current: eventSchema });

/**
 * Saves an edit made in the admin form. The api decides who may do it (administrators) and checks the
 * version; here we only pass the visitor's cookie along and turn each kind of answer into something
 * the form can show without losing what the editor typed.
 */
export async function updateEventAction(_previous: EditEventState, formData: FormData): Promise<EditEventState> {
  const eventId = parseEventId(String(formData.get("eventId") ?? ""));
  const submitted: Submitted = {
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? ""),
    capacity: String(formData.get("capacity") ?? ""),
  };
  if (eventId === undefined) return { status: "failed", message: "This event does not exist.", submitted };

  const parsed = updateEventBodySchema.safeParse({
    version: Number(formData.get("version")),
    title: submitted.title,
    description: submitted.description,
    capacity: submitted.capacity === "" ? Number.NaN : Number(submitted.capacity),
  });
  if (!parsed.success) return { status: "invalid", fields: issuesToFieldErrors(parsed.error.issues), submitted };

  const context = await getRequestContext();
  try {
    const event = await apiCall(`/events/${eventId}`, eventSchema, { ...context, method: "PATCH", body: parsed.data });
    // Show the change to this editor at once. Everyone else gets it from the worker's refresh.
    updateTag(eventTag(eventId));
    updateTag(EVENTS_TAG);
    updateTag(CITIES_TAG);
    return { status: "saved", event };
  } catch (error) {
    if (!isApiRequestError(error)) throw error;
    if (error.code === "VERSION_CONFLICT") {
      const details = eventConflictDetails.safeParse(error.details);
      if (details.success) return { status: "conflict", current: details.data.current, submitted };
    }
    if (error.status === 400) {
      const fields = (error.details?.["fields"] ?? {}) as Record<string, string[]>;
      return { status: "invalid", fields, submitted };
    }
    logger.warn({ requestId: context.requestId, status: error.status, code: error.code }, "event edit refused");
    return { status: "failed", message: error.message, submitted };
  }
}
