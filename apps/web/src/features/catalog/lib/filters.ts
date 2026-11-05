/** The catalog filters as they live in the address bar (`/?city=Paris&q=jazz&from=2026-12-01`). */
export interface CatalogFilters {
  city?: string | undefined;
  q?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Raw = string | string[] | undefined;
const first = (value: Raw): string | undefined => (Array.isArray(value) ? value[0] : value);
const clean = (value: Raw, max = 100): string | undefined => {
  const text = first(value)?.trim();
  return text ? text.slice(0, max) : undefined;
};
const cleanDate = (value: Raw): string | undefined => {
  const text = first(value)?.trim();
  if (!text || !DATE.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00Z`);
  // JavaScript turns 2026-02-30 into 2 March; a real date reads back as the same text.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : undefined;
};

/** Reads the address bar. Anything odd is ignored, so a hand-edited URL can never break the page. */
export function parseFilters(params: Record<string, Raw>): CatalogFilters {
  return { city: clean(params["city"]), q: clean(params["q"]), from: cleanDate(params["from"]), to: cleanDate(params["to"]) };
}

/** `?city=Paris&q=jazz`, or an empty string. Empty values are left out, so the same filters always give the same text. */
export function filtersToQueryString(filters: CatalogFilters): string {
  const params = new URLSearchParams();
  for (const key of ["city", "from", "q", "to"] as const) {
    const value = filters[key]?.trim();
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Same filters? (Used to ignore a "change" that changes nothing.) */
export const sameFilters = (a: CatalogFilters, b: CatalogFilters): boolean =>
  filtersToQueryString(a) === filtersToQueryString(b);
