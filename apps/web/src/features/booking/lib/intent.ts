/**
 * One attempt to book, as the visitor sees it. The Idempotency-Key is made once and reused for every
 * request of the same attempt (a double click, a retry after a dropped connection), so the api can
 * recognise them as the same booking. `finish()` ends the attempt; the next one gets a new key.
 */
export interface BookingIntent {
  key: () => string;
  finish: () => void;
}

export function createBookingIntent(makeKey: () => string = () => crypto.randomUUID()): BookingIntent {
  let current: string | undefined;
  return {
    key: () => (current ??= makeKey()),
    finish: () => {
      current = undefined;
    },
  };
}
