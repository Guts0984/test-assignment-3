/**
 * For answers that can arrive in the wrong order: ask `next()` before starting a request, and
 * `isCurrent(ticket)` when its answer arrives. Only the most recent request is current, so an
 * old answer can never overwrite a newer one.
 */
export interface LatestOnly {
  next: () => number;
  isCurrent: (ticket: number) => boolean;
  /** Makes every request started so far out of date (e.g. when the filters changed). */
  invalidate: () => void;
}

export function createLatestOnly(): LatestOnly {
  let latest = 0;
  return {
    next: () => (latest += 1),
    isCurrent: (ticket) => ticket === latest,
    invalidate: () => {
      latest += 1;
    },
  };
}
