/**
 * How long to wait before reconnecting after the `attempt`-th failure in a row (0 = the first failure):
 * about 1 s, then 2, 4, 8 ... up to 30 s. A random part (50-100 % of the base) keeps thousands of
 * browsers from all reconnecting at the same moment after a restart.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + (random() * base) / 2);
}
