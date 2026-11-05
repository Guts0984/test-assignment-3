import { eventSchema, parseEventId } from "@app/shared";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/features/auth/server";
import { apiCallOrNull } from "@/shared/api/api-client";
import { getRequestContext } from "@/shared/api/request-context";
import { EditEventForm } from "./components/edit-event-form";

/** The edit form, for administrators only. Everyone else is sent to log in. */
export async function AdminEventContent({ rawId }: { rawId: string }) {
  const id = parseEventId(rawId);
  if (id === undefined) notFound();

  const user = await getSessionUser();
  if (user?.role !== "admin") redirect(`/login?next=${encodeURIComponent(`/admin/events/${id}`)}`);

  // The form starts from what is saved right now, never from a cached copy.
  const event = await apiCallOrNull(`/events/${id}`, eventSchema, { ...(await getRequestContext()) });
  if (!event) notFound();
  return <EditEventForm event={event} />;
}
