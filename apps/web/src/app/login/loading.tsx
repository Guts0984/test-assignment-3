import { Skeleton } from "@/shared/ui/skeleton";

export default function Loading() {
  return (
    <main className="px-4 py-12" aria-busy="true" aria-label="Loading">
      <Skeleton className="mx-auto h-72 w-full max-w-sm" />
    </main>
  );
}
