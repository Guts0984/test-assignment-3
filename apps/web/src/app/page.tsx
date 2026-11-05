import { Suspense } from "react";
import { parseFilters } from "@/features/catalog";
import { CatalogContent } from "@/features/catalog/server";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata = { title: "Events" };

/** The catalog. Its filters live in the address bar, so the page is made per set of filters. */
async function Catalog({ searchParams }: PageProps<"/">) {
  const filters = parseFilters(await searchParams);
  return <CatalogContent filters={filters} />;
}

export default function HomePage(props: PageProps<"/">) {
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">Upcoming events</h1>
      <Suspense fallback={<CatalogSkeleton />}>
        <Catalog {...props} />
      </Suspense>
    </main>
  );
}

function CatalogSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading events">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    </div>
  );
}
