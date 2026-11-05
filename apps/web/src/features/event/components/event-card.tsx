import type { EventDto } from "@app/shared";
import { CalendarDays, MapPin } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/shared/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { formatEventDate } from "../format";

export function EventCard({ event }: { event: EventDto }) {
  return (
    <Card className="h-full transition-shadow hover:shadow-md">
      <CardHeader>
        <Badge variant="secondary" className="w-fit">
          {event.city}
        </Badge>
        <CardTitle className="text-lg">
          <Link href={`/events/${event.id}`} className="after:absolute after:inset-0 hover:underline focus-visible:underline">
            {event.title}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-muted-foreground">
        <p className="flex items-center gap-1">
          <CalendarDays className="size-4" aria-hidden="true" />
          <time dateTime={event.startsAt}>{formatEventDate(event.startsAt)}</time>
        </p>
        <p className="flex items-center gap-1">
          <MapPin className="size-4" aria-hidden="true" />
          {event.venue}
        </p>
      </CardContent>
    </Card>
  );
}
