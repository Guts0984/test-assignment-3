export interface Debounced<Args extends unknown[]> {
  (...args: Args): void;
  /** Drop a call that is still waiting. */
  cancel: () => void;
}

/** Runs `fn` only after `ms` without a new call; the last call wins. */
export function debounce<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: Args) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}
