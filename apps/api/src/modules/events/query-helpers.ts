import { z } from "zod";

/**
 * Turns what a visitor typed into a Postgres full-text query that matches word beginnings:
 * "orch con" -> "orch:* & con:*". Only letters and digits survive, so nobody can slip query
 * operators (& | ! : ( ) ') into it. Returns undefined when there is nothing to search for.
 */
export function toTsQuery(text: string): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return undefined;
  return words
    .slice(0, 8)
    .map((word) => `${word}:*`)
    .join(" & ");
}

/** Where the next page starts: just after this event, in (startsAt, id) order. */
export interface PageCursor {
  startsAt: string;
  id: number;
}

const cursorSchema = z.object({ t: z.iso.datetime(), i: z.number().int().positive() });

export const encodeCursor = (cursor: PageCursor): string =>
  Buffer.from(JSON.stringify({ t: cursor.startsAt, i: cursor.id })).toString("base64url");

/** Undefined for anything that is not a cursor this api made. */
export function decodeCursor(text: string): PageCursor | undefined {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(text, "base64url").toString("utf8")));
    return parsed.success ? { startsAt: parsed.data.t, id: parsed.data.i } : undefined;
  } catch {
    return undefined;
  }
}

export interface DateRange {
  /** Events starting at or after this. */
  from?: Date;
  /** Events starting strictly before this. */
  toExclusive?: Date;
}

const isPlainDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * `from=2026-12-01` starts at midnight UTC; `to=2026-12-31` includes the whole day.
 * A full date and time is used as given (`to` is inclusive to the millisecond).
 */
export function resolveDateRange(from: string | undefined, to: string | undefined): DateRange {
  const range: DateRange = {};
  if (from !== undefined) range.from = new Date(isPlainDate(from) ? `${from}T00:00:00.000Z` : from);
  if (to !== undefined) {
    const end = new Date(isPlainDate(to) ? `${to}T00:00:00.000Z` : to);
    range.toExclusive = new Date(end.getTime() + (isPlainDate(to) ? 24 * 60 * 60 * 1000 : 1));
  }
  return range;
}
