import { Skeleton } from "@/shared/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8" aria-busy="true" aria-label="Loading the editor">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-96" />
    </main>
  );
}
