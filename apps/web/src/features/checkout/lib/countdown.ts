/** Milliseconds left until `expiresAtMs`, never below zero. */
export const remainingMs = (expiresAtMs: number, nowMs: number): number => Math.max(0, expiresAtMs - nowMs);

/** 583_000 -> "9:43". Rounds up, so "0:00" only ever appears when the time is really over. */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The browser's clock may be wrong, but the server's `expiresAt` and the server's "now" agree.
 * `offset` = server time minus browser time at the moment the page was made; add it to the browser clock.
 */
export const serverNowFromBrowser = (browserNowMs: number, offsetMs: number): number => browserNowMs + offsetMs;
