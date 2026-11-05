import type { EventDto } from "@app/shared";
import { CalendarDays, MapPin } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { formatEventDate } from "../format";

export function EventDetails({ event }: { event: EventDto }) {
  return (
    <article className="space-y-3">
      <Badge variant="secondary">{event.city}</Badge>
      <h1 className="text-3xl font-semibold tracking-tight">{event.title}</h1>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CalendarDays className="size-4" aria-hidden="true" />
          <time dateTime={event.startsAt}>{formatEventDate(event.startsAt)}</time>
        </span>
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-4" aria-hidden="true" />
          {event.venue}
        </span>
      </p>
      <p className="max-w-prose leading-relaxed">{event.description}</p>
    </article>
  );
}
