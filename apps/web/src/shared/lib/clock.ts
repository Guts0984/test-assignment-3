/** The server's clock, read where a page is made per request (after `connection()`), never in a cached part. */
export const serverNowMs = (): number => Date.now();
