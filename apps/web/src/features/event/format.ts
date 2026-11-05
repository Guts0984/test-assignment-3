const dateTime = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/** `2026-12-01T18:30:00.000Z` -> `Tue, 1 Dec 2026, 18:30 UTC` (UTC, so server and browser always agree). */
export const formatEventDate = (iso: string): string => dateTime.format(new Date(iso));
