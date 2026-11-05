import { Skeleton } from "@/shared/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8" aria-busy="true" aria-label="Loading your bookings">
      <Skeleton className="h-9 w-56" />
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-20" />
      ))}
    </main>
  );
}
