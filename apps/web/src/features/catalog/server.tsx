import { getCities, getEventsPage } from "@/features/event/server";
import { CatalogFilters as FiltersForm } from "./components/catalog-filters";
import { EventList } from "./components/event-list";
import { filtersToQueryString, type CatalogFilters } from "./lib/filters";

/** The filter bar and the first page of events, for the filters in the address bar. Runs on the server. */
export async function CatalogContent({ filters }: { filters: CatalogFilters }) {
  const [cities, page] = await Promise.all([getCities().catch(() => []), getEventsPage({ ...filters, limit: 20 })]);
  // Next.js keeps the state of a page you just left (so "Back" feels instant). The list would then come back with the
  // titles it had before, so the key also changes when the first page's content changes (id + version of each event).
  const content = page.items.map((event) => `${event.id}.${event.version}`).join(",");
  return (
    <div className="space-y-8">
      <FiltersForm cities={cities} current={filters} />
      <EventList key={`${filtersToQueryString(filters)}|${content}`} initial={page} filters={filters} />
    </div>
  );
}
