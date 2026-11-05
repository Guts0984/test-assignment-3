"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { debounce } from "@/shared/lib/debounce";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { filtersToQueryString, sameFilters, type CatalogFilters } from "../lib/filters";

const SEARCH_DELAY_MS = 300;

export function CatalogFilters({ cities, current }: { cities: string[]; current: CatalogFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  // What the visitor is typing right now. Null means "show what the address bar says".
  const [typedSearch, setTypedSearch] = useState<string | null>(null);

  const go = (next: CatalogFilters) => {
    if (sameFilters(next, current)) return;
    startTransition(() => {
      // push (not replace): the Back button steps through the filters the visitor chose.
      router.push(`${pathname}${filtersToQueryString(next)}`);
    });
  };

  // One debounced function for the life of the component, always reading the latest filters.
  const searchLater = useMemo(
    () =>
      debounce((text: string, base: CatalogFilters) => {
        startTransition(() => {
          const next = { ...base, q: text };
          if (!sameFilters(next, base)) router.push(`${pathname}${filtersToQueryString(next)}`);
          // Stop showing the typed text only if the visitor has not typed more in the meantime.
          setTypedSearch((now) => (now === text ? null : now));
        });
      }, SEARCH_DELAY_MS),
    [pathname, router],
  );

  const searchValue = typedSearch ?? current.q ?? "";

  return (
    <form role="search" aria-label="Filter events" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => event.preventDefault()} aria-busy={pending}>
      <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
        <Label htmlFor="filter-q">Search</Label>
        <Input
          id="filter-q"
          type="search"
          placeholder="Title, description or venue"
          value={searchValue}
          autoComplete="off"
          onChange={(event) => {
            setTypedSearch(event.target.value);
            searchLater(event.target.value, current);
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="filter-city">City</Label>
        <select
          id="filter-city"
          className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={current.city ?? ""}
          onChange={(event) => go({ ...current, city: event.target.value || undefined })}
        >
          <option value="">All cities</option>
          {cities.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="filter-from">From</Label>
        <Input id="filter-from" type="date" value={current.from ?? ""} max={current.to} onChange={(event) => go({ ...current, from: event.target.value || undefined })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="filter-to">To</Label>
        <Input id="filter-to" type="date" value={current.to ?? ""} min={current.from} onChange={(event) => go({ ...current, to: event.target.value || undefined })} />
      </div>
    </form>
  );
}
